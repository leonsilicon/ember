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

/** Like a video's length in Photos, e.g. 0:42 or 1:02:03. */
export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Like the Photos viewer's title: Today, Yesterday, the weekday this week, else the date. */
export function describeDay(date: Date, now = new Date()) {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function describeTime(date: Date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
