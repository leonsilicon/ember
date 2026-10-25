/**
 * The splat server (frontend, a Next.js app on Vercel): a capture goes there, a Mac running its
 * agent trains it into a splat with Brush, and the splat is viewed in a browser. While recording,
 * the same server rebuilds the scene live from the stream the phone sends it.
 */
import Constants from 'expo-constants';
import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';

import { getAccount } from './username';

/** A capture's training job, as the splat server reports it. */
export type SplatJob = {
  id: string;
  /**
   * `uploading` until the zip is in, `queued` until the Mac agent picks it up; `paused` and
   * `cancelled` by the app (a cancelled one keeps nothing).
   */
  state: 'uploading' | 'queued' | 'training' | 'paused' | 'done' | 'failed' | 'cancelled';
  steps: number;
  /** Training step of the newest viewable snapshot (0 = nothing to view yet). */
  step: number;
  gaussians: number | null;
  trainSeconds: number | null;
  error: string | null;
  /** World point the viewer orbits around (null if the seed cloud couldn't tell). */
  focus: [number, number, number] | null;
};

/** Port of `vercel dev` for the splat server on a Mac (`bun run dev` in frontend). */
export const SPLAT_SERVER_PORT = 8899;

/** The splat server's access token (its SPLAT_TOKEN), built into the app from EXPO_PUBLIC_SPLAT_TOKEN. */
export const SPLAT_TOKEN = process.env.EXPO_PUBLIC_SPLAT_TOKEN ?? '';

const authorization = { Authorization: `Bearer ${SPLAT_TOKEN}` };

interface SourceCodeSpec extends TurboModule {
  getConstants(): { scriptURL: string };
}

/** Host the JS bundle was loaded from, i.e. the Mac running Metro (null in release builds). */
function devServerHost(): string | null {
  if (Platform.OS === 'web') return typeof location === 'undefined' ? null : location.hostname;
  const fromManifest = Constants.expoConfig?.hostUri?.split(':')[0];
  if (fromManifest) return fromManifest;
  // Builds that load straight from Metro (no Expo manifest) only know the bundle URL;
  // this is the same lookup React Native's own dev tools use.
  try {
    const scriptURL = TurboModuleRegistry.get<SourceCodeSpec>('SourceCode')?.getConstants().scriptURL;
    return (scriptURL && /^https?:\/\/([^/:]+)/.exec(scriptURL)?.[1]) || null;
  } catch {
    return null;
  }
}

/**
 * The deployed splat server (EXPO_PUBLIC_SPLAT_SERVER_URL), so any build reaches it from any
 * network; without one, `vercel dev` beside Metro.
 */
export function defaultServerUrl() {
  if (process.env.EXPO_PUBLIC_SPLAT_SERVER_URL) return process.env.EXPO_PUBLIC_SPLAT_SERVER_URL;
  return `http://${devServerHost() ?? 'localhost'}:${SPLAT_SERVER_PORT}`;
}

function endpoint(serverUrl: string, path: string) {
  return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

/** A page the app opens, signed in with the token (the server keeps it in a cookie). */
function signedIn(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(SPLAT_TOKEN)}`;
}

/** `agent`: whether the Mac that trains and reconstructs is connected; the rest is about that Mac. */
export async function checkServer(serverUrl: string) {
  const res = await fetch(endpoint(serverUrl, '/health'), { headers: authorization });
  if (!res.ok) throw new Error(res.status === 401 ? 'wrong access token (EXPO_PUBLIC_SPLAT_TOKEN)' : `${res.status} ${res.statusText}`);
  return (await res.json()) as { ok: boolean; agent: boolean; brush: boolean; depthWorker: boolean };
}

/** The job for a capture, or null if the server hasn't seen it. */
export async function getJob(serverUrl: string, captureId: string): Promise<SplatJob | null> {
  const res = await fetch(endpoint(serverUrl, `/api/captures/${encodeURIComponent(captureId)}`), { headers: authorization });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as SplatJob;
}

/** Pauses, resumes or cancels a capture's training; resolves with the job as it is now. */
export async function controlJob(serverUrl: string, captureId: string, action: 'pause' | 'resume' | 'cancel'): Promise<SplatJob> {
  const res = await fetch(endpoint(serverUrl, `/api/captures/${encodeURIComponent(captureId)}/control`), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const body = (await res.json().catch(() => ({}))) as SplatJob & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** The browser page that shows recordings being reconstructed live (to show; it asks for the token). */
export function liveViewerUrl(serverUrl: string) {
  return endpoint(serverUrl, '/live');
}

/**
 * The same page following whichever recording in the username's room is newest (see lib/username.ts;
 * any room's with no username), without its controls: the app loads it ahead of recording, then locks
 * it onto its recording (see LiveSplatView's `lockSession`).
 */
export function liveFollowEmbedUrl(serverUrl: string, username = getAccount().username) {
  return signedIn(endpoint(serverUrl, `/live?embed${username ? `&room=${encodeURIComponent(username)}` : ''}`));
}

/**
 * The socket the rover brain's live map goes to (hooks/use-room-publisher.ts): the username's room
 * on the server (frontend/src/web/rooms.ts), for the control page's top view. The token goes in the
 * URL, as the embed's does: a WebSocket can't send a header from here.
 */
export function roomMapIngestUrl(serverUrl: string, username: string) {
  const socket = endpoint(serverUrl, '/live/map/ingest').replace(/^http/, 'ws');
  return `${socket}?room=${encodeURIComponent(username)}&token=${encodeURIComponent(SPLAT_TOKEN)}`;
}

/** The same page for one recording (its capture id), without its controls, for showing in the app. */
export function liveEmbedUrl(serverUrl: string, captureId: string) {
  return signedIn(endpoint(serverUrl, `/live/${encodeURIComponent(captureId)}?embed`));
}

export function viewerUrl(serverUrl: string, captureId: string) {
  return signedIn(endpoint(serverUrl, `/view/${encodeURIComponent(captureId)}`));
}
