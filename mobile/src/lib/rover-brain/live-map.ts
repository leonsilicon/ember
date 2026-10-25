import type { Brain, BrainTick } from './brain';
import type { Heading } from './geometry';
import type { LeafState } from './leaf-map';

/**
 * The brain's map as the phone streams it to the web app's live top view: one JSON line on the
 * camera server's `/detections` stream every steering tick, beside the detector's box lines (which
 * carry `boxes`; this carries `type: 'map'`, so older web pages skip it). Positions are the AR
 * world's floor plane, x and z in metres, rounded to the centimetre to keep the line short.
 */
export type LiveMap = {
  type: 'map';
  /** The phone's clock, ms. */
  t: number;
  /** Null while AR tracking is lost. */
  rover: { x: number; z: number; yawDeg: number } | null;
  pile: { x: number; z: number; radiusM: number } | null;
  workRadiusM: number;
  /** `seenAgoMs`: since the camera last saw it (absent from older app builds). */
  leaves: { id: number; x: number; z: number; state: LeafState; seenAgoMs?: number }[];
  /** The leaf the autopilot is going for. */
  targetId: number | null;
  /** Bearing 0 = ahead, positive right, as the brain's corridors are. */
  corridors: { bearingDeg: number; clearanceM: number; blocked: boolean }[];
  /** Age of the LiDAR scan the corridors came from (absent from older builds; null without one). */
  scanAgeMs?: number | null;
  autopilot: { on: boolean; mode: string | null; message: string };
  load: number;
  capacity: number;
  dumped: number;
};

const cm = (v: number) => Math.round(v * 100) / 100;

export function liveMap(brain: Brain, heading: Heading | null, tick: BrainTick, nowMs: number): LiveMap {
  const step = tick.step;
  return {
    type: 'map',
    t: nowMs,
    rover: heading && { x: cm(heading.origin[0]), z: cm(heading.origin[2]), yawDeg: Math.round(heading.yawDeg) },
    pile: brain.pile && { x: cm(brain.pile.center[0]), z: cm(brain.pile.center[2]), radiusM: brain.pile.radiusM },
    workRadiusM: brain.options.autopilot.workRadiusM,
    leaves: brain.leaves
      .snapshot()
      .filter((l) => l.state !== 'collected')
      .map((l) => ({ id: l.id, x: cm(l.world[0]), z: cm(l.world[2]), state: l.state, seenAgoMs: Math.max(0, Math.round(nowMs - l.lastSeenMs)) })),
    targetId: brain.running ? (brain.autopilot.targetId ?? null) : null,
    corridors: tick.corridors.map((c) => ({ bearingDeg: c.bearingDeg, clearanceM: cm(c.clearanceM), blocked: c.blockedBy != null })),
    scanAgeMs: Number.isFinite(tick.scanAgeMs) ? Math.round(tick.scanAgeMs) : null,
    autopilot: { on: brain.running, mode: brain.running ? brain.autopilot.mode : null, message: step?.message ?? '' },
    load: brain.autopilot.load,
    capacity: brain.options.autopilot.capacity,
    dumped: brain.dumped,
  };
}

/** A `/detections` line as a live map, or null if it's something else (a box frame). */
export function parseLiveMap(line: string): LiveMap | null {
  try {
    const value = JSON.parse(line) as Partial<LiveMap>;
    return value?.type === 'map' && Array.isArray(value.leaves) && Array.isArray(value.corridors) ? (value as LiveMap) : null;
  } catch {
    return null;
  }
}
