import Link from 'next/link';

import { publicJob, type Job } from '#jobs.ts';
import { signedIn } from '#web/auth.ts';
import { agentInfo, jobStore } from '#web/redis.ts';

import styles from './page.module.css';
import { Refresh } from './refresh';
import { SignIn } from './sign-in';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Splat captures' };

function describe(job: Job) {
  const seed = job.mode === 'lidar' ? 'LiDAR seed' : job.mode === 'features' ? 'feature-point seed (no LiDAR)' : 'seed';
  const progress =
    job.state === 'training' ? `training ${job.step.toLocaleString()} / ${job.steps.toLocaleString()} steps` : job.state;
  if (job.state === 'uploading' || job.state === 'queued') return progress;
  const gaussians = job.gaussians ? ` · ${job.gaussians.toLocaleString()} gaussians` : '';
  return `${progress}${gaussians} · ${job.frames} frames · ${seed}, ${job.seedPoints.toLocaleString()} pts`;
}

export default async function CapturesPage() {
  if (!(await signedIn())) return <SignIn />;
  const [jobs, agent] = await Promise.all([jobStore().list(), agentInfo()]);
  return (
    <main className={styles.main}>
      <h1>Splat captures</h1>
      {!agent && <p className={styles.failed}>The Mac agent is offline, so nothing trains until it reconnects.</p>}
      {jobs.length ? (
        <ul className={styles.list}>
          {jobs.map(publicJob).map((job) => (
            <li key={job.id}>
              <Link href={`/view/${job.id}`}>{job.id}</Link>
              <span className={`${styles.state} ${job.state === 'failed' ? styles.failed : ''}`}>{describe(job)}</span>
              {job.error && <pre className={styles.error}>{job.error}</pre>}
            </li>
          ))}
        </ul>
      ) : (
        <p>No captures yet. Record one in the app and it appears here.</p>
      )}
      <p className={styles.state}>
        <Link href="/live">Live reconstruction</Link> · API: <code>GET /api/captures</code>, <code>GET /api/captures/:id</code>,{' '}
        <code>GET /api/captures/:id/splat.ply</code> (with <code>Authorization: Bearer</code>)
      </p>
      <Refresh every={3000} />
    </main>
  );
}
