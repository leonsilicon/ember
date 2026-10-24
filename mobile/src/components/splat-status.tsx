import { useEventListener } from 'expo';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { compact } from '@/lib/captures';
import { controlJob, getJob, SPLAT_TOKEN, viewerUrl, type SplatJob } from '@/lib/splat-server';

type State =
  | { kind: 'checking' }
  /** The server has never seen this capture. */
  | { kind: 'idle' }
  | { kind: 'uploading'; sent: number; total: number }
  | { kind: 'job'; job: SplatJob }
  | { kind: 'error'; message: string };

const POLL_MS = 2000;

/**
 * Captures `autoStart` has sent, for the session: the gallery mounts a page more than once (and the
 * Info sheet shows the same capture), and each must not send it again. And the ones being sent
 * right now, so two views of one capture can't upload it twice.
 */
const autoStarted = new Set<string>();
const uploading = new Set<string>();

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A capture's splat, trained on the Mac behind the splat server: how far it has got, with pause,
 * cancel and open. With `autoStart`, a capture the server has never seen is sent as soon as this
 * shows (the gallery does that the first time a capture is opened); one that was cancelled or
 * failed waits to be asked. `onDark`: over the gallery's black, in white.
 */
export function SplatStatus({
  capture,
  serverUrl,
  autoStart = false,
  onDark = false,
}: {
  capture: SavedCapture;
  serverUrl: string;
  autoStart?: boolean;
  onDark?: boolean;
}) {
  const theme = useTheme();
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEventListener(SplatCapture, 'onUploadProgress', (p) => {
    if (p.captureId !== capture.captureId) return;
    setState((s) => (s.kind === 'uploading' ? { kind: 'uploading', sent: p.sentBytes, total: p.totalBytes } : s));
  });

  async function upload() {
    const { captureId } = capture;
    if (uploading.has(captureId)) return;
    uploading.add(captureId);
    autoStarted.add(captureId);
    setState({ kind: 'uploading', sent: 0, total: capture.bytes });
    try {
      const res = await SplatCapture.uploadCapture(captureId, serverUrl, SPLAT_TOKEN);
      const body = JSON.parse(res.body || '{}');
      if (res.status !== 201) throw new Error(body.error ?? `server replied ${res.status}`);
      setState({ kind: 'job', job: body as SplatJob });
    } catch (error) {
      setState({ kind: 'error', message: `Upload failed: ${message(error)}` });
    } finally {
      uploading.delete(captureId);
    }
  }

  // Pick up a splat that was already made, and follow training while it runs.
  const jobState = state.kind === 'job' ? state.job.state : null;
  const following = jobState === 'uploading' || jobState === 'queued' || jobState === 'training' || jobState === 'paused';
  useEffect(() => {
    if (state.kind !== 'checking' && !following) return;
    let alive = true;
    const poll = async () => {
      try {
        const job = await getJob(serverUrl, capture.captureId);
        if (!alive) return;
        if (job) setState({ kind: 'job', job });
        else if (uploading.has(capture.captureId)) setState({ kind: 'uploading', sent: 0, total: capture.bytes });
        else if (autoStart && !autoStarted.has(capture.captureId)) upload();
        else setState({ kind: 'idle' });
      } catch (error) {
        if (alive) setState({ kind: 'error', message: `Server unreachable: ${message(error)}` });
      }
    };
    if (state.kind === 'checking') poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `upload` and `autoStart` are stable for a capture
  }, [capture.captureId, serverUrl, state.kind, following]);

  async function control(action: 'pause' | 'resume' | 'cancel') {
    try {
      setState({ kind: 'job', job: await controlJob(serverUrl, capture.captureId, action) });
    } catch (error) {
      setState({ kind: 'error', message: message(error) });
    }
  }

  const job = state.kind === 'job' ? state.job : null;
  const canStart =
    state.kind === 'idle' ||
    state.kind === 'error' ||
    job?.state === 'uploading' ||
    job?.state === 'failed' ||
    job?.state === 'cancelled' ||
    job?.state === 'done';
  const color = onDark ? '#fff' : theme.text;
  const dim = onDark ? 'rgba(255,255,255,0.7)' : theme.textSecondary;

  return (
    // Fixed heights: the status changes every couple of seconds while training, and the row must
    // not grow or shrink under the user's finger as it does.
    <View style={[styles.container, onDark && styles.onDark]}>
      <Text style={[styles.status, { color: dim }]} numberOfLines={2}>
        {state.kind === 'checking' && 'Splat: checking…'}
        {state.kind === 'idle' && 'Splat: not made yet'}
        {state.kind === 'uploading' && `Splat: sending ${Math.round((100 * state.sent) / Math.max(state.total, 1))}%`}
        {state.kind === 'error' && `Splat: ${state.message}`}
        {job && describe(job)}
      </Text>
      <View style={styles.row}>
        {state.kind === 'uploading' && <ActivityIndicator color={color} />}
        {canStart && <Action label={job?.state === 'done' ? 'Train again' : 'Make splat'} color={color} onPress={upload} />}
        {(job?.state === 'queued' || job?.state === 'training') && (
          <Action label="Pause" color={color} onPress={() => control('pause')} />
        )}
        {job?.state === 'paused' && <Action label="Resume" color={color} onPress={() => control('resume')} />}
        {(job?.state === 'queued' || job?.state === 'training' || job?.state === 'paused') && (
          <Action label="Cancel" color={color} onPress={() => control('cancel')} />
        )}
        {job && job.step > 0 && (
          <Action
            label="Open splat"
            color={color}
            onPress={() => WebBrowser.openBrowserAsync(viewerUrl(serverUrl, capture.captureId))}
          />
        )}
      </View>
    </View>
  );
}

function describe(job: SplatJob) {
  const gaussians = job.gaussians ? ` · ${compact(job.gaussians)} gaussians` : '';
  switch (job.state) {
    case 'uploading':
      return 'Splat: the upload did not finish';
    case 'queued':
      return 'Splat: queued on the Mac';
    case 'training':
      return `Splat: training ${compact(job.step)} / ${compact(job.steps)} steps${gaussians}`;
    case 'paused':
      return `Splat: paused at ${compact(job.step)} / ${compact(job.steps)} steps${gaussians}`;
    case 'done':
      return `Splat: ready, trained in ${job.trainSeconds ?? '?'} s${gaussians}`;
    case 'failed':
      return `Splat failed: ${job.error ?? 'unknown error'}`;
    case 'cancelled':
      return 'Splat: cancelled';
  }
}

function Action({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  /** A translucent panel over the gallery's black, like its error panel. */
  onDark: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  status: {
    fontSize: 14,
    lineHeight: 20,
    // Two lines.
    minHeight: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.four,
    minHeight: 34,
  },
  action: {
    paddingVertical: Spacing.half,
  },
  actionText: {
    fontSize: 15,
    fontWeight: 600,
  },
  pressed: {
    opacity: 0.6,
  },
});
