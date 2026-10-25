import SplatCapture, { type SavedCapture } from '../../modules/splat-capture';

import { SPLAT_TOKEN, type SplatJob } from './splat-server';

/** An upload of a capture to the splat server, from the moment it's asked for. */
export type UploadState =
  | { kind: 'uploading'; sent: number; total: number }
  /** The server has the whole zip and has queued it for the Mac. */
  | { kind: 'sent'; job: SplatJob }
  | { kind: 'failed'; message: string };

type Listener = (state: UploadState) => void;

// For the session, by capture id: every capture an upload was started for. One that was sent (or
// failed) stays, so nothing sends it again without being asked.
const uploads = new Map<string, UploadState>();
const listeners = new Map<string, Set<Listener>>();
let progress: { remove(): void } | null = null;

function set(captureId: string, state: UploadState) {
  uploads.set(captureId, state);
  listeners.get(captureId)?.forEach((listener) => listener(state));
}

/** Calls `listener` whenever the capture's upload changes, until the returned function is called. */
export function subscribeUpload(captureId: string, listener: Listener) {
  let set = listeners.get(captureId);
  if (!set) listeners.set(captureId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(captureId);
  };
}

/** This session's upload of a capture, if one was started. */
export function uploadOf(captureId: string) {
  return uploads.get(captureId);
}

export function isUploading(captureId: string) {
  return uploads.get(captureId)?.kind === 'uploading';
}

/**
 * Sends a capture's zip to the splat server, which queues it for the Mac to train. The camera starts
 * this the moment a recording is saved, so the splat is under way before anyone looks for it; the
 * gallery's Make splat and Train again start it by hand. The zip goes straight from disk, natively
 * (CaptureUploader.swift), so it carries on while the user does other things in the app;
 * `subscribeUpload` follows it. One upload per capture at a time: asked again while one runs, this
 * waits for that one.
 */
export async function uploadCapture(capture: SavedCapture, serverUrl: string): Promise<UploadState> {
  const { captureId } = capture;
  if (isUploading(captureId)) return settled(captureId);
  progress ??= SplatCapture.addListener('onUploadProgress', (p) => {
    if (isUploading(p.captureId)) set(p.captureId, { kind: 'uploading', sent: p.sentBytes, total: p.totalBytes });
  });
  set(captureId, { kind: 'uploading', sent: 0, total: capture.bytes });
  let result: UploadState;
  try {
    const res = await SplatCapture.uploadCapture(captureId, serverUrl, SPLAT_TOKEN);
    const body = JSON.parse(res.body || '{}');
    if (res.status !== 201) throw new Error(body.error ?? `server replied ${res.status}`);
    result = { kind: 'sent', job: body as SplatJob };
  } catch (error) {
    result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  set(captureId, result);
  return result;
}

/** Resolves when the capture's running upload has finished, either way. */
function settled(captureId: string) {
  return new Promise<UploadState>((resolve) => {
    const unsubscribe = subscribeUpload(captureId, (state) => {
      if (state.kind === 'uploading') return;
      unsubscribe();
      resolve(state);
    });
  });
}
