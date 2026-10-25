import Link from 'next/link';

import { publicJob, type Job } from '#jobs.ts';
import { currentLogin, requireSignIn } from '#web/auth.ts';
import { agentInfo, jobStore } from '#web/redis.ts';

import { logout } from '../actions';
import { Refresh } from '../refresh';
import styles from './dashboard.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard · soon2026' };

const TOOLS = [
  { href: '/control', title: 'Rover control', text: 'Drive the rover and arm from the laptop, with the splat viewer and the phone camera.' },
  { href: '/live', title: 'Live reconstruction', text: 'Follow the phone’s recording as the Mac rebuilds it in 3D.' },
  { href: '/sim', title: 'Autopilot sim', text: 'The rover’s own brain clearing a virtual yard.' },
  { href: '/wildfire', title: 'Wildfire hazard map', text: 'Buildings and their wildfire hazard, on a map.' },
];

function describe(job: Job) {
  const seed = job.mode === 'lidar' ? 'LiDAR seed' : job.mode === 'features' ? 'feature-point seed (no LiDAR)' : 'seed';
  const progress =
    job.state === 'training' ? `training ${job.step.toLocaleString()} / ${job.steps.toLocaleString()} steps` : job.state;
  if (job.state === 'uploading' || job.state === 'queued') return progress;
  const gaussians = job.gaussians ? ` · ${job.gaussians.toLocaleString()} gaussians` : '';
  return `${progress}${gaussians} · ${job.frames} frames · ${seed}, ${job.seedPoints.toLocaleString()} pts`;
}

/** Everything behind the sign-in: the laptop tools, the live view and the captures as they train. */
export default async function DashboardPage() {
  await requireSignIn('/dashboard');
  const [who, jobs, agent] = await Promise.all([currentLogin(), jobStore().list(), agentInfo()]);
  return (
    <main className={styles.main}>
      <header className={styles.top}>
        <div>
          <h1>Dashboard</h1>
          <p className={styles.state}>soon2026 · {who ? `signed in as ${who}` : 'rover, live 3D and splat captures'}</p>
        </div>
        <form action={logout}>
          <button type="submit" className={styles.signOut}>
            Sign out
          </button>
        </form>
      </header>

      <section className={styles.section} aria-labelledby="tools">
        <h2 id="tools">Tools</h2>
        <ul className={styles.tools}>
          {TOOLS.map((tool) => (
            <li key={tool.href}>
              <Link href={tool.href}>
                <strong>{tool.title}</strong>
                <span>{tool.text}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="captures">
        <h2 id="captures">Splat captures</h2>
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
          API: <code>GET /api/captures</code>, <code>GET /api/captures/:id</code>, <code>GET /api/captures/:id/splat.ply</code>{' '}
          (with <code>Authorization: Bearer</code>)
        </p>
      </section>
      <Refresh every={3000} />
    </main>
  );
}
