import { useSyncExternalStore } from 'react';

import { defaultServerUrl } from '@/lib/splat-server';

export type SplatSettings = {
  /** The splat server (src/lib/splat-server.ts): captures train there, and recordings stream there live. */
  serverUrl: string;
  /** Stream each recording to the server's live reconstruction, shown floating over the camera. On unless turned off. */
  liveStream: boolean;
};

// Shared by every screen for the session; not persisted.
let settings: SplatSettings = { serverUrl: defaultServerUrl(), liveStream: true };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateSplatSettings(patch: Partial<SplatSettings>) {
  settings = { ...settings, ...patch };
  listeners.forEach((l) => l());
}

export function useSplatSettings() {
  return useSyncExternalStore(subscribe, () => settings, () => settings);
}
