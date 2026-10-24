import { useSyncExternalStore } from 'react';

import { defaultServerUrl } from '@/lib/splat-preview';

export type DebugSettings = {
  /** Show the splat-preview tools. On by default in development builds only. */
  splatPreview: boolean;
  serverUrl: string;
};

// Shared by every screen for the session; not persisted.
let settings: DebugSettings = { splatPreview: __DEV__, serverUrl: defaultServerUrl() };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateDebugSettings(patch: Partial<DebugSettings>) {
  settings = { ...settings, ...patch };
  listeners.forEach((l) => l());
}

export function useDebugSettings() {
  return useSyncExternalStore(subscribe, () => settings, () => settings);
}
