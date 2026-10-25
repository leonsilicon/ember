import type Redis from 'ioredis';

import type { CaptureMode } from './dataset';

/**
 * `uploading` until the phone's zip is in Blob, then `queued` until the Mac agent trains it. The
 * app can pause a queued or training job (`paused`) and cancel one (`cancelled`: nothing is kept,
 * and it trains again only when asked).
 */
export type JobState = 'uploading' | 'queued' | 'training' | 'paused' | 'done' | 'failed' | 'cancelled';

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
  /** The username the phone that uploaded it was set to (its `X-Room` header; see rooms.ts); null from a phone with none. */
  room: string | null;
  /** While training: its Brush is stopped so that a newer capture trains first, and carries on after it (agent/trainer.ts). */
  held?: boolean;
};

/**
 * The job as stored: also the steps whose snapshots are in Blob. That is the newest, and the one
 * before it while training, so a viewer mid-download of it when a newer one lands still gets it.
 */
export type StoredJob = Job & {
  snapshots: number[];
  /** While paused: what it was, so resuming queues it again or lets Brush carry on. */
  pausedFrom?: 'queued' | 'training';
};

export function publicJob({ snapshots: _, pausedFrom: __, ...job }: StoredJob): Job {
  return job;
}

export function newJob(id: string, room: string | null = null): StoredJob {
  return {
    id,
    room,
    createdAt: new Date().toISOString(),
    state: 'uploading',
    mode: 'unknown',
    frames: 0,
    seedPoints: 0,
    steps: 0,
    step: 0,
    gaussians: null,
    trainSeconds: null,
    error: null,
    focus: null,
    snapshots: [],
  };
}

/** How long the phone has to finish an upload: its presigned upload URL lasts this long. */
export const UPLOAD_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Where a capture's files are in the Blob store. */
export const blobPath = {
  zip: (id: string) => `captures/${id}/capture.zip`,
  transforms: (id: string) => `captures/${id}/transforms.json`,
  snapshot: (id: string, step: number) => `captures/${id}/splat-${step}.ply`,
};

/** The capture jobs, in a Redis hash, so the app and the Mac agent see the same list. */
export class JobStore {
  constructor(
    private redis: Redis,
    private key: string,
  ) {}

  async get(id: string): Promise<StoredJob | null> {
    const json = await this.redis.hget(this.key, id);
    return json ? (JSON.parse(json) as StoredJob) : null;
  }

  async list(): Promise<StoredJob[]> {
    const jobs = (await this.redis.hvals(this.key)).map((json) => JSON.parse(json) as StoredJob);
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async put(job: StoredJob) {
    await this.redis.hset(this.key, job.id, JSON.stringify(job));
    return job;
  }
}
