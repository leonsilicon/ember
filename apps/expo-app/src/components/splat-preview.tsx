import { useEventListener } from 'expo';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { compact } from '@/lib/captures';
import { getJob, SPLAT_TOKEN, viewerUrl, type SplatJob } from '@/lib/splat-preview';

type State =
  | { kind: 'checking' }
  | { kind: 'idle' }
  | { kind: 'uploading'; sent: number; total: number }
  | { kind: 'job'; job: SplatJob }
  | { kind: 'error'; message: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Debug: trains a capture into a splat on the preview server and opens it in the
 * browser, to compare with the production reconstruction.
 */
export function SplatPreview({ capture, serverUrl }: { capture: SavedCapture; serverUrl: string }) {
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEventListener(SplatCapture, 'onUploadProgress', (p) => {
    if (p.captureId !== capture.captureId) return;
    setState((s) => (s.kind === 'uploading' ? { kind: 'uploading', sent: p.sentBytes, total: p.totalBytes } : s));
  });

  // Pick up a preview that was already made, and follow training while it runs.
  const jobState = state.kind === 'job' ? state.job.state : null;
  useEffect(() => {
    if (state.kind !== 'checking' && jobState !== 'queued' && jobState !== 'training') return;
    let alive = true;
    const poll = async () => {
      try {
        const job = await getJob(serverUrl, capture.captureId);
        if (alive) setState(job ? { kind: 'job', job } : { kind: 'idle' });
      } catch (error) {
        if (alive) setState({ kind: 'error', message: `Preview server unreachable: ${message(error)}` });
      }
    };
    if (state.kind === 'checking') poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [capture.captureId, serverUrl, state.kind, jobState]);

  async function upload() {
    setState({ kind: 'uploading', sent: 0, total: capture.bytes });
    try {
      const res = await SplatCapture.uploadCapture(capture.captureId, serverUrl, SPLAT_TOKEN);
      const body = JSON.parse(res.body || '{}');
      if (res.status !== 201) throw new Error(body.error ?? `server replied ${res.status}`);
      setState({ kind: 'job', job: body as SplatJob });
    } catch (error) {
      setState({ kind: 'error', message: `Upload failed: ${message(error)}` });
    }
  }

  const job = state.kind === 'job' ? state.job : null;
  // A finished preview can be retrained too, e.g. after changing the server's Brush settings.
  const canRetry =
    state.kind === 'idle' || state.kind === 'error' || job?.state === 'uploading' || job?.state === 'failed' || job?.state === 'done';

  return (
    // Fixed heights: the status changes every couple of seconds while training, and the
    // card must not grow or shrink under the user's finger as it does.
    <View style={styles.container}>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.status}>
        {state.kind === 'checking' && 'Debug preview: checking…'}
        {state.kind === 'idle' && 'Debug preview: not trained yet'}
        {state.kind === 'uploading' &&
          `Debug preview: uploading ${Math.round((100 * state.sent) / Math.max(state.total, 1))}%`}
        {state.kind === 'error' && `Debug preview: ${state.message}`}
        {job && describe(job)}
      </ThemedText>
      <View style={styles.row}>
        {state.kind === 'uploading' && <ActivityIndicator />}
        {canRetry && <Action label={job ? 'Retrain splat' : 'Preview splat'} onPress={upload} />}
        {job && job.step > 0 && (
          <Action
            label="Open splat"
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
      return 'Debug preview: the upload did not finish';
    case 'queued':
      return 'Debug preview: queued on the Mac';
    case 'training':
      return `Debug preview: training ${compact(job.step)} / ${compact(job.steps)} steps${gaussians}`;
    case 'done':
      return `Debug preview: trained in ${job.trainSeconds ?? '?'} s${gaussians}`;
    case 'failed':
      return `Debug preview failed: ${job.error ?? 'unknown error'}`;
  }
}

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <ThemedText type="linkPrimary">{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  status: {
    // Two lines of the "small" text style (lineHeight 20).
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
  pressed: {
    opacity: 0.6,
  },
});
