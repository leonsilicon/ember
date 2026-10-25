import Link from 'next/link';

import { publicJob } from '#jobs.ts';
import { agentInfo, jobStore } from '#web/redis.ts';

import { describe, progress, uploadExpired } from './capture-progress';
import styles from './captures-panel.module.css';

/**
 * The captures, over the live reconstruction (a recording is rebuilt live here, then trained into
 * one of these). Splats: only the captures whose zip is fully uploaded and whose training on the Mac
 * has run to the end, each opening its viewer. Processing: the rest, as far as they've got (a
 * failed or cancelled one too, until the app sends it again, and an upload the phone never
 * finished, called out once its upload URL has expired). The page refreshes it.
 */
export async function CapturesPanel() {
  const [jobs, agent] = await Promise.all([jobStore().list(), agentInfo()]);
  const all = jobs.map(publicJob);
  const splats = all.filter((job) => job.state === 'done');
  const processing = all.filter((job) => job.state !== 'done');
  return (
    <details className={styles.panel} open>
      <summary>
        Splats{splats.length ? ` · ${splats.length}` : ''}
        {processing.length > 0 && <span className={styles.badge}>{processing.length} processing</span>}
      </summary>
      <div className={styles.body}>
        {!agent && <p className={styles.failed}>The Mac agent is offline, so nothing trains until it reconnects.</p>}
        {splats.length ? (
          <ul className={styles.list}>
            {splats.map((job) => (
              <li key={job.id}>
                <Link href={`/view/${job.id}`}>{job.id}</Link>
                <span className={styles.state}>{describe(job)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.state}>
            {all.length ? 'No finished splats yet.' : 'No captures yet. Record one in the app and it appears here.'}
          </p>
        )}
        {processing.length > 0 && (
          <>
            <h2 className={styles.heading}>Processing</h2>
            <ul className={styles.list}>
              {processing.map((job) => (
                <li key={job.id}>
                  <span className={styles.name}>{job.id}</span>
                  <span className={`${styles.state} ${job.state === 'failed' || uploadExpired(job) ? styles.failed : ''}`}>{progress(job)}</span>
                  {job.error && <pre className={styles.error}>{job.error}</pre>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}
