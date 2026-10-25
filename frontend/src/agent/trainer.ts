import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ServerConfig } from '../config';
import { DatasetError, extractCapture, plyVertexCount } from '../dataset';
import { blobPath, type JobStore, type StoredJob } from '../jobs';
import type { Storage } from './storage';

const SNAPSHOT = /^splat_(\d+)\.ply$/;

/**
 * How many captures may be on hold at once. A held Brush keeps its memory (a few GB) while it is
 * stopped, so past this a newer capture waits for the GPU instead; it still goes before the held ones.
 */
const MAX_HELD = 3;

/** A capture that has started: its train() is in flight, and its Brush, once spawned, runs or is stopped. */
type Run = {
  id: string;
  brush: ChildProcess | null;
  /** The job as last read or saved, for a save made before the store is read again. */
  job: StoredJob | null;
  /** Saves to the job go one after another, so none writes over another's fields. */
  saving: Promise<unknown>;
  /** The app paused it: its Brush stays stopped until the app resumes it. */
  paused: boolean;
  /** The app cancelled it: its Brush is stopped, and nothing of it is kept. */
  cancelled: boolean;
  task: Promise<void>;
};

/** Resolves with how a process ended: its exit code, or the signal that stopped it. */
function exited(proc: ChildProcess) {
  return new Promise<number | NodeJS.Signals>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve(code ?? signal ?? -1));
  });
}

/**
 * Trains the captures the app queues with Brush, newest first. One Brush trains at a time (the GPU
 * is the bottleneck); a capture that arrives while another trains takes its place, and that one's
 * Brush is stopped (SIGSTOP, as the app's pause does) until the newer one is done, then carries on.
 * So the splat someone has just recorded is the one being made, and earlier ones finish after it.
 * A job fetches the phone's zip from storage, and Brush exports a snapshot every `exportEvery`
 * steps; the newest finished one goes back to storage for the viewer, so a splat appears long
 * before training ends.
 */
export class Trainer {
  /** Captures to start, newest first. */
  private waiting: string[] = [];
  /** Captures that have started, by id. */
  private runs = new Map<string, Run>();
  /** The run whose Brush is on the GPU (or will be, once its zip is in). */
  private running: Run | null = null;
  /** Runs put on hold for a newer capture, newest first; their Brush is stopped. */
  private held: Run[] = [];
  private closed = false;
  private scheduled = false;
  private idle: Promise<void> = Promise.resolve();
  private settle: (() => void) | null = null;

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
    return this.runs.has(id) || this.waiting.includes(id);
  }

  /** Queues the capture ahead of any still waiting: the newest trains first. */
  enqueue(id: string) {
    if (this.closed || this.isBusyWith(id)) return;
    this.waiting.unshift(id);
    if (!this.settle) this.idle = new Promise((resolve) => (this.settle = resolve));
    this.schedule();
  }

  /** Resolves once nothing is waiting or training (used by tests). */
  whenIdle() {
    return this.idle;
  }

  /** Stops every Brush and leaves their jobs as they are, so the agent trains them again when it next starts. */
  async close() {
    this.closed = true;
    this.waiting = [];
    for (const run of this.runs.values()) this.stopBrush(run);
    await Promise.all([...this.runs.values()].map((run) => run.task));
    this.settle?.();
    this.settle = null;
  }

  /**
   * Stops the job's Brush, if it has one, and gives the GPU to the next capture (a job that hasn't
   * started is held back by the app, see control/route.ts).
   */
  pause(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    run.paused = true;
    run.brush?.kill('SIGSTOP');
    this.held = this.held.filter((other) => other !== run);
    if (this.running === run) this.running = null;
    this.schedule();
  }

  /**
   * Lets the job's Brush carry on once whatever is training is done, or trains it from the start if
   * it has none (the agent restarted).
   */
  resume(id: string) {
    const run = this.runs.get(id);
    if (!run) return this.enqueue(id);
    if (!run.paused) return;
    run.paused = false;
    this.held.unshift(run);
    this.schedule();
  }

  /** Drops the job: stops its Brush if it has one, and keeps none of its output. */
  cancel(id: string) {
    this.waiting = this.waiting.filter((queued) => queued !== id);
    const run = this.runs.get(id);
    if (!run) return;
    run.cancelled = true;
    this.stopBrush(run);
  }

  /** A stopped process doesn't see a termination signal until it runs again. */
  private stopBrush(run: Run) {
    run.brush?.kill('SIGCONT');
    run.brush?.kill();
  }

  /** Works out what's on the GPU once the calls that got here have settled (the agent re-queues jobs in a batch when it starts). */
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  private tick() {
    if (this.closed) return;
    // The newest capture goes first: one that arrives while another trains puts that one on hold.
    if (this.running && this.waiting.length && this.held.length < MAX_HELD) {
      const run = this.running;
      this.running = null;
      run.brush?.kill('SIGSTOP');
      this.held.unshift(run);
      console.log(`${run.id}: on hold while ${this.waiting[0]} trains`);
      this.record(run, { held: true });
    }
    if (!this.running) {
      const id = this.waiting.shift();
      if (id !== undefined) {
        this.start(id);
      } else {
        const run = this.held.shift();
        if (run) {
          this.running = run;
          run.brush?.kill('SIGCONT');
          console.log(`${run.id}: carrying on`);
          this.record(run, { held: false });
        }
      }
    }
    if (!this.runs.size && !this.waiting.length) {
      this.settle?.();
      this.settle = null;
    }
  }

  private start(id: string) {
    const run: Run = { id, brush: null, job: null, saving: Promise.resolve(), paused: false, cancelled: false, task: Promise.resolve() };
    this.runs.set(id, run);
    this.running = run;
    run.task = this.train(run)
      .catch(async (error) => {
        if (this.closed) return;
        // e.g. the Brush binary can't be spawned, or Blob stayed unreachable. Fail this job and keep going.
        await this.save(run, { state: 'failed', error: String(error), held: false }).catch(() => {});
      })
      .finally(() => {
        // Never leave a Brush on the GPU behind a finished job.
        this.stopBrush(run);
        this.runs.delete(id);
        this.release(run);
      });
  }

  /** The run is off the GPU (its Brush has exited): whatever is next can have it. */
  private release(run: Run) {
    if (this.running === run) this.running = null;
    this.held = this.held.filter((other) => other !== run);
    this.schedule();
  }

  /** Saves `patch` over the job as stored now (the app may have paused or cancelled it meanwhile), one save at a time. */
  private save(run: Run, patch: Partial<StoredJob>) {
    const next = run.saving.then(async () => {
      const current = (await this.store.get(run.id)) ?? run.job;
      if (!current) throw new Error(`${run.id} is not in the job store`);
      run.job = await this.store.put({ ...current, ...patch });
      return run.job;
    });
    run.saving = next.catch(() => {});
    return next;
  }

  /** A save whose failure is only worth a line in the log (the app shows the job as it was). */
  private record(run: Run, patch: Partial<StoredJob>) {
    this.save(run, patch).catch((error) => console.warn(`${run.id}: couldn't save ${JSON.stringify(patch)}: ${error}`));
  }

  private async train(run: Run) {
    const { id } = run;
    const stored = await this.store.get(id);
    // The queue can repeat a job (it is also re-queued when the agent starts); train it only once.
    if (stored?.state !== 'queued' && stored?.state !== 'training') return;
    run.job = stored;
    const { brushBin, dataDir, steps, exportEvery, maxResolution, shDegree, growthFraction, maxSplats } = this.config;
    if (!brushBin) {
      await this.save(run, { state: 'failed', error: 'Brush is not installed on the Mac; run frontend/scripts/install-brush.sh' });
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
      await this.save(run, { state: 'failed', error: error.message });
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
    await this.storage.remove(stored.snapshots.map((step) => blobPath.snapshot(id, step)));
    await this.save(run, {
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
      held: this.held.includes(run),
    });

    const started = performance.now();
    console.log(`${id}: training (${capture.frames} frames, ${capture.mode} seed)${this.running === run ? '' : ', stopped until its turn'}`);
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
    run.brush = proc;
    let done = false;
    // Listening straight away: a binary that can't start reports it as an 'error' event.
    const exit = exited(proc).finally(() => {
      done = true;
      run.brush = null;
      // The GPU is free while the last snapshot uploads.
      this.release(run);
    });
    exit.catch(() => {}); // awaited below; this keeps it from counting as unhandled meanwhile
    // Only the run on the GPU trains: one on hold, or paused by the app, starts stopped and carries on when it's its
    // turn. One cancelled (or the agent stopped) while its zip was coming in is not wanted at all.
    if (run.cancelled || this.closed) this.stopBrush(run);
    else if (this.running !== run) proc.kill('SIGSTOP');
    let stderr = '';
    proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    await log.close();
    while (!done) {
      await Promise.race([exit, sleep(1000)]);
      if (this.closed || run.cancelled) break;
      // A snapshot that can't be published now (the network stayed down past storage's own retries)
      // is still on disk, so the next tick tries again; Brush carries on meanwhile.
      if (!done) {
        await this.publishSnapshot(run, false).catch((error) => console.warn(`${id}: couldn't publish a snapshot yet: ${error}`));
      }
    }

    const code = await exit;
    if (this.closed) return;
    const job = run.job as StoredJob;
    if (run.cancelled) {
      await rm(runDir, { recursive: true, force: true });
      await this.storage.remove([...job.snapshots.map((step) => blobPath.snapshot(id, step)), blobPath.zip(id)]);
      await this.save(run, { state: 'cancelled', step: 0, snapshots: [], gaussians: null, trainSeconds: null, error: null, held: false });
      console.log(`${id}: cancelled`);
      return;
    }
    const trainSeconds = Math.round((performance.now() - started) / 100) / 10;
    // Brush may have written its last snapshots while an upload was still going.
    try {
      await this.publishSnapshot(run, true);
    } catch (error) {
      // The splat stays on disk in runDir; the capture's zip too, in storage, for a later try.
      const message = error instanceof Error ? error.message : String(error);
      await this.save(run, { state: 'failed', trainSeconds, held: false, error: `trained, but the splat couldn't be stored: ${message}` });
      return;
    }
    if (code === 0 && (run.job as StoredJob).step > 0) {
      await this.save(run, { state: 'done', trainSeconds, held: false });
      console.log(`${id}: done in ${trainSeconds} s (${(run.job as StoredJob).gaussians ?? '?'} gaussians)`);
    } else {
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      await this.save(run, { state: 'failed', trainSeconds, held: false, error: `Brush exited with code ${code}${tail ? `: ${tail}` : ''}` });
      console.warn(`${id}: Brush exited with code ${code}`);
    }
    // The splat is what's kept; a capture to train again has to be uploaded again.
    await this.storage.remove([blobPath.zip(id)]);
  }

  /**
   * Publishes the newest complete snapshot. While Brush runs, a snapshot only counts once it has
   * stopped growing, since Brush may still be writing it. The previously published snapshot is
   * kept too (see StoredJob); anything older is deleted, on disk and in storage.
   */
  private async publishSnapshot(run: Run, finished: boolean) {
    const job = run.job as StoredJob;
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
    await this.save(run, fresh ? { step: ready.step, gaussians: await plyVertexCount(ready.file), snapshots: keep } : { snapshots: keep });
    await this.storage.remove(dropped.map((step) => blobPath.snapshot(job.id, step)));
    for (const old of snapshots) {
      if (old.step < Math.min(...keep)) await rm(old.file, { force: true });
    }
  }
}
