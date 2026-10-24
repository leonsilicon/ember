import * as Sharing from 'expo-sharing';

import type { SavedCapture } from '../../modules/splat-capture';

/** Opens the share sheet (AirDrop, Messages, Save to Files, …) for a capture zip. */
export async function shareCapture(capture: SavedCapture) {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(capture.uri, { dialogTitle: 'Send capture' });
}

export function describeCapture(capture: SavedCapture) {
  const seed =
    capture.mode === 'lidar' ? 'LiDAR points' : capture.mode === 'features' ? 'feature points' : 'seed points';
  const parts = [
    capture.frames !== undefined ? `${capture.frames} frames` : null,
    capture.points !== undefined ? `${compact(capture.points)} ${seed}` : null,
    formatBytes(capture.bytes),
  ];
  return parts.filter(Boolean).join(' · ');
}

export function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString();
}

export function formatBytes(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
