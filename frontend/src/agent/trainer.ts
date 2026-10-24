import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ServerConfig } from '../config';
import { DatasetError, extractCapture, plyVertexCount } from '../dataset';
import { blobPath, type JobStore, type StoredJob } from '../jobs';
import type { Storage } from './storage';

const SNAPSHOT = /^splat_(\d+)\.ply$/;

/** Resolves with how a process ended: its exit code, or the signal that stopped it. */
function exited(proc: ChildProcess) {
  return new Promise<number | NodeJS.Signals>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve(code ?? signal ?? -1));
  });
}

/**
 * Trains one capture at a time with Brush (the GPU is the bottleneck, so jobs never overlap). It
 * fetches the phone's zip from storage, and Brush exports a snapshot every `exportEvery` steps;
 * the newest finished one goes back to storage for the viewer, so a splat appears long before
 * training ends.
 */
export class Trainer {
  private queue: string[] = [];
  private active: string | null = null;
  private brush: ChildProcess | null = null;
  private closed = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private store: JobStore,
    private storage: Storage,
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

  isBusyWith(id: string) {
    return this.active === id || this.queue.includes(id);
  }

  enqueue(id: string) {
    if (this.closed || this.isBusyWith(id)) return;
    this.queue.push(id);
    if (!this.active) this.idle = this.pump();
  }

  /** Resolves once the queue has drained (used by tests). */
  whenIdle() {
    return this.idle;
  }

  /** Stops Brush and leaves its job as it is, so the agent trains it again when it next starts. */
  async close() {
    this.closed = true;
    this.queue = [];
    this.brush?.kill();
    await this.idle;
  }

  private async pump() {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      this.active = id;
      try {
        await this.train(id);
      } catch (error) {
        if (this.closed) return;
        // e.g. the Brush binary can't be spawned, or Blob is unreachable. Fail this job, keep the queue moving.
        const job = await this.store.get(id).catch(() => null);
        if (job) await this.store.put({ ...job, state: 'failed', error: String(error) }).catch(() => {});
      } finally {
        this.active = null;
      }
    }
  }

  private async train(id: string) {
    const stored = await this.store.get(id);
    // The queue can repeat a job (it is also re-queued when the agent starts); train it only once.
    if (stored?.state !== 'queued' && stored?.state !== 'training') return;
    let job: StoredJob = stored;
    const save = async (patch: Partial<StoredJob>) => (job = await this.store.put({ ...job, ...patch }));
    const { brushBin, dataDir, steps, exportEvery, maxResolution, shDegree, growthFraction, maxSplats } = this.config;
    if (!brushBin) {
      await save({ state: 'failed', error: 'Brush is not installed on the Mac; run frontend/scripts/install-brush.sh' });
      return;
    }

    const zip = path.join(dataDir, 'uploads', `${id}.zip`);
    const extractDir = path.join(dataDir, 'captures', id);
    await mkdir(path.dirname(zip), { recursive: true });
    await rm(extractDir, { recursive: true, force: true });
    let capture;
    try {
      await this.storage.download(blobPath.zip(id), zip);
      capture = await extractCapture(zip, extractDir);
    } catch (error) {
      await rm(extractDir, { recursive: true, force: true });
      if (!(error instanceof DatasetError)) throw error;
      await save({ state: 'failed', error: error.message });
      await this.storage.remove([blobPath.zip(id)]);
      return;
    } finally {
      await rm(zip, { force: true });
    }
    await this.storage.upload(blobPath.transforms(id), path.join(capture.datasetDir, 'transforms.json'), 'application/json');

    const runDir = this.runDir(id);
    await rm(runDir, { recursive: true, force: true });
    await mkdir(runDir, { recursive: true });
    // Snapshots from an earlier attempt (one the agent was stopped in the middle of).
    await this.storage.remove(job.snapshots.map((step) => blobPath.snapshot(id, step)));
    await save({
      state: 'training',
      mode: capture.mode,
      frames: capture.frames,
      seedPoints: capture.seedPoints,
      focus: capture.focus,
      steps,
      step: 0,
      snapshots: [],
      gaussians: null,
      error: null,
    });

    const started = performance.now();
    const log = await open(path.join(runDir, 'brush.log'), 'w');
    const proc = spawn(
      brushBin,
      [
        capture.datasetDir,
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
      { stdio: ['ignore', log.fd, 'pipe'] },
    );
    this.brush = proc;
    let done = false;
    // Listening straight away: a binary that can't start reports it as an 'error' event.
    const exit = exited(proc).finally(() => {
      done = true;
      this.brush = null;
    });
    exit.catch(() => {}); // awaited below; this keeps it from counting as unhandled meanwhile
    let stderr = '';
    proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    await log.close();
    while (!done) {
      await Promise.race([exit, sleep(1000)]);
      if (this.closed) break;
      if (!done) await this.publishSnapshot(job, false, save);
    }

    const code = await exit;
    if (this.closed) return;
    // Brush may have written its last snapshots while an upload was still going.
    await this.publishSnapshot(job, true, save);
    const trainSeconds = Math.round((performance.now() - started) / 100) / 10;
    if (code === 0 && job.step > 0) {
      await save({ state: 'done', trainSeconds });
    } else {
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      await save({ state: 'failed', trainSeconds, error: `Brush exited with code ${code}${tail ? `: ${tail}` : ''}` });
    }
    // The splat is what's kept; a capture to train again has to be uploaded again.
    await this.storage.remove([blobPath.zip(id)]);
  }

  /**
   * Publishes the newest complete snapshot. While Brush runs, a snapshot only counts once it has
   * stopped growing, since Brush may still be writing it. The previously published snapshot is
   * kept too (see StoredJob); anything older is deleted, on disk and in storage.
   */
  private async publishSnapshot(job: StoredJob, finished: boolean, save: (patch: Partial<StoredJob>) => Promise<StoredJob>) {
    const snapshots = await Promise.all(
      (await this.snapshots(job.id)).map(async (s) => ({ ...s, mtimeMs: (await stat(s.file)).mtimeMs })),
    );
    const ready = snapshots.find((s) => finished || Date.now() - s.mtimeMs > 1500);
    if (!ready) return;
    const fresh = ready.step !== job.step;
    if (!fresh && !finished) return;

    if (fresh) await this.storage.upload(blobPath.snapshot(job.id, ready.step), ready.file, 'application/octet-stream');
    // Once training is over only the final snapshot is worth keeping.
    const keep = finished ? [ready.step] : [ready.step, job.step].filter((step) => step > 0);
    const dropped = job.snapshots.filter((step) => !keep.includes(step));
    await save(fresh ? { step: ready.step, gaussians: await plyVertexCount(ready.file), snapshots: keep } : { snapshots: keep });
    await this.storage.remove(dropped.map((step) => blobPath.snapshot(job.id, step)));
    for (const old of snapshots) {
      if (old.step < Math.min(...keep)) await rm(old.file, { force: true });
    }
  }
}
