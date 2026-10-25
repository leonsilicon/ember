import { UPLOAD_WINDOW_MS, type Job } from '#jobs.ts';

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** An upload the phone can no longer finish: its upload URL has expired (the phone lost the network, or the app was killed). */
export function uploadExpired(job: Job, now = Date.now()) {
  return job.state === 'uploading' && now - Date.parse(job.createdAt) > UPLOAD_WINDOW_MS;
}

/** How far a capture that isn't a splat yet has got. */
export function progress(job: Job, now = Date.now()) {
  const steps = `${job.step.toLocaleString()} / ${job.steps.toLocaleString()} steps`;
  switch (job.state) {
    case 'uploading': {
      const started = `started ${ago(now - Date.parse(job.createdAt))}`;
      return uploadExpired(job, now) ? `upload never finished · ${started}` : `uploading from the phone · ${started}`;
    }
    case 'queued':
      return 'uploaded · waiting for the Mac';
    case 'training':
      return job.held ? `on hold at ${steps} while a newer capture trains` : `training ${steps}`;
    case 'paused':
      return `paused at ${steps}`;
    default:
      return job.state;
  }
}

/** A finished splat, in a line. */
export function describe(job: Job) {
  const seed = job.mode === 'lidar' ? 'LiDAR seed' : job.mode === 'features' ? 'feature-point seed (no LiDAR)' : 'seed';
  const gaussians = job.gaussians ? `${job.gaussians.toLocaleString()} gaussians · ` : '';
  const time = job.trainSeconds != null ? ` · trained in ${Math.round(job.trainSeconds)} s` : '';
  return `${gaussians}${job.frames} frames · ${seed}, ${job.seedPoints.toLocaleString()} pts${time}`;
}

/** A time as the captures list shows it: "Oct 25, 3:14 PM". */
export function when(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
