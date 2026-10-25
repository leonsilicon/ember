'use client';

import { useEffect, useRef, useState } from 'react';

import type { Job } from '#jobs.ts';
import { Hint, Led, Readout, type Tone } from '#rover/ui/kit.tsx';
import { Module } from '#rover/ui/layout.tsx';
import { Shell } from '#rover/ui/Shell.tsx';

import { progress, when } from '../../live/capture-progress';
import { CapturesModule } from '../../live/captures-module';

const POLL_MS = 3000;
const PENDING = new Set<Job['state']>(['uploading', 'queued', 'training', 'paused']);
const TONE: Record<Job['state'], Tone> = { uploading: 'info', queued: 'info', training: 'live', paused: 'warn', done: 'ok', failed: 'danger', cancelled: 'off' };
const WORD: Record<Job['state'], string> = {
  uploading: 'Uploading',
  queued: 'Queued',
  training: 'Training',
  paused: 'Paused',
  done: 'Trained',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** The capture's job, polled while it's still moving (the scene polls too, for its snapshots; this is for the readouts). */
function useJob(id: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/captures/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        const next = (await response.json()) as Job;
        if (disposed) return;
        setJob(next);
        setError(null);
        if (PENDING.has(next.state)) timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(poll, POLL_MS * 2);
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id]);
  return { job, error };
}

/**
 * A capture's splat (/view/[id]) in Ember's shell: the newest snapshot on the stage, loaded again as
 * training produces newer ones (splat-scene.ts), the capture's readouts and the other captures beside it.
 */
export default function ViewApp({ id }: { id: string }) {
  const { job, error } = useJob(id);
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('loading…');

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    // three.js and Spark need the browser, so the scene loads only there.
    import('./splat-scene').then(({ SplatScene }) => {
      if (disposed || !container.current) return;
      const scene = new SplatScene(container.current, id, setStatus);
      dispose = () => scene.dispose();
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [id]);

  const seed = job?.mode === 'lidar' ? 'LiDAR' : job?.mode === 'features' ? 'feature points (no LiDAR)' : '–';
  // A capture on hold is training in name only: a newer one has the GPU until it's done.
  const held = job?.state === 'training' && job.held === true;
  const word = job ? (held ? 'On hold' : WORD[job.state]) : 'Loading…';
  const tone: Tone = job ? (held ? 'warn' : TONE[job.state]) : 'off';

  return (
    <Shell
      page="/live"
      shortcuts={[]}
      status={
        <span className="hidden items-center gap-2 text-[13px] md:flex">
          <Led tone={tone} blink={job?.state === 'training' && !held} />
          <span className="text-ink">{word}</span>
          <span className="num text-ink-3">{id}</span>
        </span>
      }
      stage={
        <div ref={container} className="absolute inset-0 overflow-hidden [&_canvas]:block [&_canvas]:touch-none">
          <div className="pointer-events-none absolute top-3 left-3 max-w-[calc(100%-24px)] rounded-[10px] border border-line bg-panel/95 px-3 py-2 text-xs text-ink-2 shadow-float backdrop-blur">
            <span className="num">{status}</span>
          </div>
        </div>
      }
      modules={
        <>
          <Module id="capture" title="Capture" meta={job ? word.toLowerCase() : undefined}>
            {job ? (
              <dl>
                <Readout label="Capture">{job.id}</Readout>
                <Readout label="State" tone={job.state === 'failed' ? 'danger' : job.state === 'paused' || held ? 'warn' : undefined}>
                  {job.state === 'done' ? 'trained' : progress(job)}
                </Readout>
                <Readout label="Steps">
                  {job.step.toLocaleString()} / {job.steps.toLocaleString()}
                </Readout>
                <Readout label="Gaussians">{job.gaussians?.toLocaleString() ?? '–'}</Readout>
                <Readout label="Frames">{job.frames.toLocaleString()}</Readout>
                <Readout label="Seed">
                  {seed}
                  {job.seedPoints ? ` · ${job.seedPoints.toLocaleString()} pts` : ''}
                </Readout>
                {job.trainSeconds != null && <Readout label="Trained in">{Math.round(job.trainSeconds)} s</Readout>}
                <Readout label="Recorded">{when(job.createdAt)}</Readout>
              </dl>
            ) : error ? (
              <p className="rounded-md border border-line bg-well px-3 py-2 text-xs leading-relaxed text-ink-2">
                Couldn't read the capture: <span className="text-danger">{error}</span>
              </p>
            ) : (
              <div className="flex flex-col gap-1.5" aria-label="Loading the capture">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="h-7 animate-pulse rounded-md bg-well" />
                ))}
              </div>
            )}
            {job?.error && <pre className="num mt-2 whitespace-pre-wrap text-[11px] leading-snug text-danger">{job.error}</pre>}
            <Hint className="mt-3">The newest snapshot loads as training goes. Drag to orbit, scroll to zoom; pause, resume and cancel are in the app's gallery.</Hint>
          </Module>

          <CapturesModule current={id} />
        </>
      }
    />
  );
}
