'use client';

import { useEffect, useRef, type RefObject } from 'react';

import { useAccount } from '#rover/ui/account.tsx';
import { Button, Field, Hint, IconButton, Icons, Kbd, Led, Readout, Segmented, type Tone } from '#rover/ui/kit.tsx';
import { Module } from '#rover/ui/layout.tsx';
import { isShortcutEvent, Shell, type Shortcut } from '#rover/ui/Shell.tsx';

import { when } from './capture-progress';
import { CapturesModule } from './captures-module';
import { CONFIDENCE, useLiveReconstruction } from './live-reconstruction';

const SHORTCUTS: Shortcut[] = [
  { keys: ['F'], label: 'Follow the phone' },
  { keys: ['C'], label: 'Show more or fewer points' },
];

/**
 * Live 3D (/live, /live/[session]): the phone's recording rebuilt on the Mac as it goes, in Ember's
 * shell. The stage is the reconstruction (live-scene.ts); the rail has the session's readouts, the
 * view's controls and the captures, which the recording becomes once it stops. The app's own view
 * of the same reconstruction is live-viewer.tsx.
 */
export default function LiveApp({ session: requested }: { session: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  const live = useLiveReconstruction(container, requested, false);
  const { setFollow, cycleConfidence } = live;
  // The room: phones set to this username are the ones this page follows (null: a token-signed browser, every phone).
  const who = useAccount();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isShortcutEvent(event)) return;
      if (event.key === 'f') setFollow((on) => !on);
      else if (event.key === 'c') cycleConfidence();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [setFollow, cycleConfidence]);

  const { connection, agentOnline, session, stats, phoneOn } = live;
  const tone: Tone = connection !== 'open' ? 'warn' : !agentOnline ? 'danger' : phoneOn ? 'live' : session ? 'ok' : 'off';
  const word =
    connection === 'connecting'
      ? 'Connecting…'
      : connection === 'reconnecting'
        ? 'Reconnecting…'
        : !agentOnline
          ? 'Mac agent offline'
          : phoneOn
            ? 'Phone streaming'
            : session
              ? 'Recording ended'
              : 'No recording yet';
  const depth = session?.mode === 'lidar' ? 'LiDAR' : session?.mode === 'features' ? 'feature points (no LiDAR)' : '–';

  return (
    <Shell
      page="/live"
      shortcuts={SHORTCUTS}
      status={
        <span className="hidden items-center gap-2 text-[13px] md:flex">
          <Led tone={tone} blink={connection !== 'open' || phoneOn} />
          <span className="text-ink">{word}</span>
          {session && <span className="num text-ink-3">{session.id}</span>}
        </span>
      }
      actions={
        <IconButton label={live.follow ? 'Following the phone (F)' : 'Follow the phone (F)'} pressed={live.follow} onClick={() => setFollow(!live.follow)}>
          <Icons.follow />
        </IconButton>
      }
      banner={
        connection === 'open' &&
        !agentOnline && (
          <div className="mx-2 mb-2 flex items-center gap-3 rounded-[10px] border border-danger/40 bg-panel py-1.5 pr-3.5 pl-3.5 lg:mx-2.5">
            <Led tone="danger" />
            <p className="text-[13px] text-ink">
              <span className="font-semibold">The Mac agent is offline.</span>{' '}
              <span className="text-ink-2">
                Nothing is rebuilt or trained until it reconnects (the <span className="num">soon2026-agent</span> pm2 service on Leon's Mac, or{' '}
                <span className="num">bun run agent</span> in frontend).
              </span>
            </p>
          </div>
        )
      }
      stage={<LiveStage live={live} container={container} who={who} />}
      modules={
        <>
          <Module id="session" title="Session" meta={session ? (session.mode === 'lidar' ? 'LiDAR' : 'no LiDAR') : undefined}>
            {session ? (
              <dl>
                <Readout label="Recording">{session.id}</Readout>
                {session.device && <Readout label="Phone">{session.device}</Readout>}
                {session.room && !who && <Readout label="Username">{session.room}</Readout>}
                <Readout label="Depth">{depth}</Readout>
                <Readout label="Streaming">{phoneOn ? 'yes' : 'no'}</Readout>
                <Readout label="Points">{stats?.voxels.toLocaleString() ?? '–'}</Readout>
                <Readout label="Keyframes">{stats ? `${stats.fused.toLocaleString()} fused of ${stats.received.toLocaleString()}` : '–'}</Readout>
                {stats?.skipped ? (
                  <Readout label="Skipped" tone="warn">
                    {stats.skipped.toLocaleString()}
                  </Readout>
                ) : null}
                {stats?.fitError != null && <Readout label="Depth fit">±{(stats.fitError * 100).toFixed(1)}%</Readout>}
                {stats?.fuseMs != null && <Readout label="Fuse time">{stats.fuseMs} ms</Readout>}
                <Readout label="Started">{when(session.startedAt)}</Readout>
              </dl>
            ) : (
              <Hint>
                {requested
                  ? 'This recording has not reached the server yet, or the agent has let it go.'
                  : who
                    ? `No recording yet. This page follows whichever phone set to the username ${who} starts streaming next.`
                    : 'No recording yet. This page follows whichever phone starts streaming next.'}
              </Hint>
            )}
            {stats?.lastSkip && <p className="mt-2 text-xs leading-snug text-warn">Last skip: {stats.lastSkip}</p>}
          </Module>

          <Module id="view" title="View" meta={CONFIDENCE[live.confidence][1]}>
            <div className="flex flex-col gap-3.5">
              <Field label="Camera" value={<Kbd>F</Kbd>} hint="Dragging the view stops following the phone until you turn it back on.">
                <Button
                  size="sm"
                  aria-pressed={live.follow}
                  onClick={() => setFollow(!live.follow)}
                  className="self-start aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-panel aria-pressed:hover:bg-ink"
                >
                  <Icons.follow />
                  {live.follow ? 'Following the phone' : 'Follow the phone'}
                </Button>
              </Field>
              <Field label="Show" value={<Kbd>C</Kbd>} hint="Points seen by more keyframes are the surer ones.">
                <Segmented
                  options={CONFIDENCE.map((_, i) => i)}
                  value={live.confidence}
                  onChange={live.setConfidence}
                  label="Points to show"
                  render={(i) => CONFIDENCE[i][1]}
                  size="sm"
                />
              </Field>
              <Field label="Point size" htmlFor="live-size" value={<span className="num text-xs text-ink-2">{live.size.toFixed(1)}×</span>}>
                <input id="live-size" type="range" min="0.4" max="3" step="0.1" value={live.size} onChange={(e) => live.setSize(Number(e.target.value))} className="w-full" />
              </Field>
              <Button size="sm" disabled={!session || !live.hasPoints} onClick={live.download} className="self-start">
                <Icons.download />
                Download PLY
              </Button>
            </div>
          </Module>

          <CapturesModule agentOnline={agentOnline} />
        </>
      }
      railFooter={
        <p className="px-1 pt-1 pb-2 text-[11px] leading-snug text-ink-3">
          In the app, {who ? <>set the username to <span className="num text-ink-2">{who}</span> (camera options), </> : ''}turn on Live 3D in the camera options and start
          recording: the points appear here as the phone moves, and the capture trains into a splat when it stops.
        </p>
      }
    />
  );
}

/** The reconstruction, filling the stage, with its readout top-left and a word while there's nothing to see. */
function LiveStage({ live, container, who }: { live: ReturnType<typeof useLiveReconstruction>; container: RefObject<HTMLDivElement | null>; who: string | null }) {
  const s = live.stats;
  return (
    <div ref={container} className="absolute inset-0 overflow-hidden [&_canvas]:block [&_canvas]:touch-none">
      {s && (
        <div className="pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-24px)] flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[10px] border border-line bg-panel/95 px-3 py-2 text-xs text-ink-2 shadow-float backdrop-blur">
          <span className="num text-ink">{s.voxels.toLocaleString()} points</span>
          <span className="num">
            {s.fused.toLocaleString()} keyframes fused{s.skipped ? `, ${s.skipped.toLocaleString()} skipped` : ''}
          </span>
          {s.fitError != null && <span className="num">depth fit ±{(s.fitError * 100).toFixed(1)}%</span>}
          {s.fuseMs != null && <span className="num">{s.fuseMs} ms/keyframe</span>}
        </div>
      )}
      {!live.hasPoints && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center">
          <div className="max-w-sm">
            <p className="text-[15px] font-semibold text-[#eeece7]">{!live.agentOnline ? 'The Mac agent is offline' : 'Waiting for the phone'}</p>
            <p className="mt-1 text-[13px] leading-snug text-[#8f8a81]">
              {!live.agentOnline
                ? 'Live 3D starts once it reconnects.'
                : who
                  ? `In the app, set the username to ${who} and turn on Live 3D, then start recording. Points appear here as you move the phone around.`
                  : 'In the app, turn on Live 3D, then start recording. Points appear here as you move the phone around.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
