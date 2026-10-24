import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ServerConfig } from './config';
import { plyVertexCount, type CaptureMode } from './dataset';

export type JobState = 'queued' | 'training' | 'done' | 'failed';

/** One capture and the splat being trained from it. This is the API's public shape. */
export type Job = {
  id: string;
  createdAt: string;
  state: JobState;
  mode: CaptureMode;
  frames: number;
  seedPoints: number;
  steps: number;
  /** Training step of the newest snapshot that can be viewed (0 = none yet). */
  step: number;
  gaussians: number | null;
  trainSeconds: number | null;
  error: string | null;
  /** World point a viewer should orbit around, from the seed cloud (null if unknown). */
  focus: [number, number, number] | null;
};

type StoredJob = Job & { datasetDir: string };

export function publicJob({ datasetDir: _, ...job }: StoredJob): Job {
  return job;
}

/** Jobs persisted as one JSON file, so the list survives a server restart. */
export class JobStore {
  private jobs = new Map<string, StoredJob>();
  private saving = Promise.resolve();

  constructor(private file: string) {}

  async load() {
    const file = Bun.file(this.file);
    if (!(await file.exists())) return;
    for (const job of (await file.json()) as StoredJob[]) this.jobs.set(job.id, job);
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(job: StoredJob) {
    this.jobs.set(job.id, job);
    // Serialise writes so a slow write can't land after a newer one.
    const snapshot = JSON.stringify([...this.jobs.values()], null, 2);
    this.saving = this.saving.then(() => Bun.write(this.file, snapshot).then(() => {}));
    return job;
  }

  flush() {
    return this.saving;
  }
}

const SNAPSHOT = /^splat_(\d+)\.ply$/;

/**
 * Trains one capture at a time with Brush (the GPU is the bottleneck, so jobs
 * never overlap). Brush exports a snapshot every `exportEvery` steps; the newest
 * finished one is what the viewer shows, so a splat appears long before training ends.
 */
export class Trainer {
  private queue: string[] = [];
  private active: string | null = null;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private store: JobStore,
    private config: ServerConfig,
  ) {}

  runDir(id: string) {
    return path.join(this.config.dataDir, 'runs', id);
  }

  /** Snapshots on disk, newest first. Brush zero-pads the step (`splat_0500.ply`). */
  async snapshots(id: string) {
    const runDir = this.runDir(id);
    const found: { step: number; file: string }[] = [];
    for (const name of await readdir(runDir).catch(() => [])) {
      const match = SNAPSHOT.exec(name);
      if (match) found.push({ step: Number(match[1]), file: path.join(runDir, name) });
    }
    return found.sort((a, b) => b.step - a.step);
  }

  async snapshotPath(id: string, step: number) {
    return (await this.snapshots(id)).find((s) => s.step === step)?.file ?? null;
  }

  isBusyWith(id: string) {
    return this.active === id || this.queue.includes(id);
  }

  enqueue(id: string) {
    if (this.isBusyWith(id)) return;
    this.queue.push(id);
    if (!this.active) this.idle = this.pump();
  }

  /** Resolves once the queue has drained (used by tests). */
  whenIdle() {
    return this.idle;
  }

  private async pump() {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      this.active = id;
      try {
        await this.train(id);
      } catch (error) {
        // e.g. the Brush binary can't be spawned. Fail this job, keep the queue moving.
        const job = this.store.get(id);
        if (job) this.store.update({ ...job, state: 'failed', error: String(error) });
      } finally {
        this.active = null;
      }
    }
  }

  private async train(id: string) {
    let job = this.store.get(id);
    if (!job) return;
    const { brushBin, steps, exportEvery, maxResolution, shDegree, growthFraction, maxSplats } = this.config;
    if (!brushBin) {
      this.store.update({ ...job, state: 'failed', error: 'Brush is not installed; run server/scripts/install-brush.sh' });
      return;
    }
    const runDir = this.runDir(id);
    await rm(runDir, { recursive: true, force: true });
    await mkdir(runDir, { recursive: true });
    job = this.store.update({ ...job, state: 'training', steps, step: 0, gaussians: null, error: null });

    const started = performance.now();
    const proc = Bun.spawn(
      [
        brushBin,
        job.datasetDir,
        '--total-steps', String(steps),
        '--max-resolution', String(maxResolution),
        '--sh-degree', String(shDegree),
        '--export-every', String(exportEvery),
        '--export-path', runDir,
        '--export-name', 'splat_{iter}.ply',
        '--eval-every', '1000000000',
        '--growth-select-fraction', String(growthFraction),
        '--max-splats', String(maxSplats),
      ],
      { stdout: Bun.file(path.join(runDir, 'brush.log')), stderr: 'pipe' },
    );
    const stderr = new Response(proc.stderr).text();

    let exited = false;
    const exit = proc.exited.finally(() => {
      exited = true;
    });
    while (!exited) {
      await Promise.race([exit, Bun.sleep(1000)]);
      await this.publishSnapshot(id, exited);
    }

    const code = await exit;
    const current = this.store.get(id)!;
    const trainSeconds = Math.round((performance.now() - started) / 100) / 10;
    if (code === 0 && current.step > 0) {
      this.store.update({ ...current, state: 'done', trainSeconds });
    } else {
      const tail = (await stderr).trim().split('\n').slice(-5).join('\n');
      this.store.update({
        ...current,
        state: 'failed',
        trainSeconds,
        error: `Brush exited with code ${code}${tail ? `: ${tail}` : ''}`,
      });
    }
  }

  /**
   * Points the job at the newest complete snapshot. While Brush runs, a snapshot only
   * counts once it has stopped growing, since Brush may still be writing it. The
   * previously published snapshot is kept too, so a viewer that is mid-download of it
   * when a newer one lands still gets its file; anything older is deleted.
   */
  private async publishSnapshot(id: string, finished: boolean) {
    const snapshots = await Promise.all(
      (await this.snapshots(id)).map(async (s) => ({ ...s, mtimeMs: (await stat(s.file)).mtimeMs })),
    );
    const ready = snapshots.find((s) => finished || Date.now() - s.mtimeMs > 1500);
    const job = this.store.get(id);
    if (!ready || !job || ready.step === job.step) return;

    const previous = job.step;
    this.store.update({ ...job, step: ready.step, gaussians: await plyVertexCount(ready.file) });
    // Once training is over only the final snapshot is worth keeping.
    const keepFrom = finished ? ready.step : previous;
    for (const old of snapshots) {
      if (old.step < keepFrom) await rm(old.file, { force: true });
    }
  }
}
