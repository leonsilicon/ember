'use client';

import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';

import type { Job } from '#jobs.ts';
import { useCaptures, viewable } from '#rover/hooks/useCaptures.ts';
import { Hint, IconButton, Icons, Led, type Tone } from '#rover/ui/kit.tsx';
import { Module } from '#rover/ui/layout.tsx';

import { describe, progress, uploadExpired, when } from './capture-progress';

/** The app's gallery polls at this rate too. */
const REFRESH_MS = 3000;

const TONE: Partial<Record<Job['state'], Tone>> = { done: 'ok', training: 'live', paused: 'warn', failed: 'danger', queued: 'info', uploading: 'info' };

/**
 * The captures: the phone's recordings, trained into splats on the Mac. Finished splats open their
 * viewer; the rest show how far they've got (one that failed or was cancelled too, until the app
 * sends it again, and an upload the phone never finished, called out once its upload URL has
 * expired), and open the viewer as soon as a first snapshot exists. `current` is the capture whose
 * viewer this is. `agentOnline` is false when the socket says the Mac agent has gone.
 */
export function CapturesModule({ current, agentOnline }: { current?: string; agentOnline?: boolean }) {
  const { state, refresh } = useCaptures();
  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const all = state.kind === 'ready' ? state.captures : [];
  const splats = all.filter((job) => job.state === 'done');
  const processing = all.filter((job) => job.state !== 'done');
  const meta =
    state.kind === 'ready'
      ? `${splats.length} splat${splats.length === 1 ? '' : 's'}${processing.length ? ` · ${processing.length} processing` : ''}`
      : state.kind === 'loading'
        ? 'loading…'
        : 'offline';

  return (
    <Module
      id="captures"
      title="Captures"
      meta={meta}
      actions={
        <IconButton label="Refresh captures" onClick={() => void refresh()} className="h-7 w-7">
          <Icons.restart />
        </IconButton>
      }
    >
      {agentOnline === false && (
        <p className="mb-2 rounded-md border border-line bg-well px-3 py-2 text-xs leading-relaxed text-ink-2">
          <span className="font-medium text-danger">The Mac agent is offline</span>, so nothing trains until it reconnects.
        </p>
      )}
      {state.kind === 'loading' && (
        <div className="flex flex-col gap-1.5" aria-label="Loading captures">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-10 animate-pulse rounded-md bg-well" />
          ))}
        </div>
      )}
      {state.kind === 'error' && (
        <p className="rounded-md border border-line bg-well px-3 py-2 text-xs leading-relaxed text-ink-2">
          Couldn't list the captures: <span className="text-danger">{state.message}</span>. They're stored with the deployed app; a local
          server needs its Redis and Blob settings (<span className="num">vercel env pull</span>).
        </p>
      )}
      {state.kind === 'ready' && all.length === 0 && <Hint>No captures yet. Record one in the app; it appears here as it uploads and trains.</Hint>}
      {splats.length > 0 && (
        <ul className="-mx-1.5 flex max-h-72 flex-col overflow-y-auto" aria-label="Splats">
          {splats.map((job) => (
            <li key={job.id}>
              <Row job={job} current={job.id === current} tone="ok">
                {describe(job)} · {when(job.createdAt)}
              </Row>
            </li>
          ))}
        </ul>
      )}
      {processing.length > 0 && (
        <>
          <h3 className="mt-3 mb-1 text-[11px] font-semibold tracking-[0.14em] text-ink-3 uppercase">Processing</h3>
          <ul className="-mx-1.5 flex flex-col" aria-label="Captures in progress">
            {processing.map((job) => {
              const stuck = job.state === 'failed' || uploadExpired(job);
              return (
                <li key={job.id}>
                  <Row job={job} current={job.id === current} tone={stuck ? 'danger' : job.held ? 'warn' : (TONE[job.state] ?? 'off')} blink={(job.state === 'training' && !job.held) || job.state === 'uploading'} warn={stuck}>
                    {progress(job)}
                  </Row>
                  {job.error && <pre className="num mx-1.5 mb-1 whitespace-pre-wrap text-[11px] leading-snug text-ink-3">{job.error}</pre>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Module>
  );
}

/** One capture: a link to its viewer once there's a snapshot to show, a plain row before that. */
function Row({ job, current, tone, blink, warn, children }: { job: Job; current: boolean; tone: Tone; blink?: boolean; warn?: boolean; children: ReactNode }) {
  const body = (
    <>
      <Led tone={tone} blink={blink} />
      <span className="min-w-0 flex-1">
        <span className="num block truncate text-[13px] text-ink">{job.id}</span>
        <span className={`block truncate text-[11px] ${warn ? 'text-danger' : 'text-ink-3'}`}>{children}</span>
      </span>
      {current && <span className="text-[11px] font-medium text-ember-ink">Showing</span>}
    </>
  );
  const className = `flex items-center gap-2.5 rounded-md px-1.5 py-2 transition-colors ${current ? 'bg-ember-soft' : 'hover:bg-well'}`;
  if (!viewable(job)) return <span className={`${className} hover:bg-transparent`}>{body}</span>;
  return (
    <Link href={`/view/${encodeURIComponent(job.id)}`} aria-current={current ? 'page' : undefined} className={className}>
      {body}
    </Link>
  );
}
