/**
 * Debug splat preview: a capture is trained into a splat by the Brush server in
 * server/ (run on a Mac with `bun run splat-server`) and viewed in a browser, so the
 * result can be compared with the production reconstruction.
 */
import Constants from 'expo-constants';
import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';

/** A capture's training job, as server/ reports it. */
export type SplatJob = {
  id: string;
  state: 'queued' | 'training' | 'done' | 'failed';
  steps: number;
  /** Training step of the newest viewable snapshot (0 = nothing to view yet). */
  step: number;
  gaussians: number | null;
  trainSeconds: number | null;
  error: string | null;
  /** World point the viewer orbits around (null if the seed cloud couldn't tell). */
  focus: [number, number, number] | null;
};

export const SPLAT_SERVER_PORT = 8899;

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

/** The preview server runs beside Metro in development; EXPO_PUBLIC_SPLAT_SERVER_URL overrides it. */
export function defaultServerUrl() {
  if (process.env.EXPO_PUBLIC_SPLAT_SERVER_URL) return process.env.EXPO_PUBLIC_SPLAT_SERVER_URL;
  return `http://${devServerHost() ?? 'localhost'}:${SPLAT_SERVER_PORT}`;
}

function endpoint(serverUrl: string, path: string) {
  return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

export async function checkServer(serverUrl: string) {
  const res = await fetch(endpoint(serverUrl, '/health'));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as { ok: boolean; brush: string | null; depthWorker?: boolean };
}

/** The job for a capture, or null if the server hasn't seen it. */
export async function getJob(serverUrl: string, captureId: string): Promise<SplatJob | null> {
  const res = await fetch(endpoint(serverUrl, `/api/captures/${encodeURIComponent(captureId)}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as SplatJob;
}

/** The browser page that shows recordings being reconstructed live. */
export function liveViewerUrl(serverUrl: string) {
  return endpoint(serverUrl, '/live');
}

export function viewerUrl(serverUrl: string, captureId: string) {
  return endpoint(serverUrl, `/view/${encodeURIComponent(captureId)}`);
}
