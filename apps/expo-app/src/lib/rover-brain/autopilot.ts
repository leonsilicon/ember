/**
 * Drive-to-leaf autopilot: a pure step function, called a few times a second with the rover's
 * current heading, the leaf map and the corridors; it returns wheel speeds for `drive()`.
 *
 * - **searching**: no leaf to go for. Turn in place to look around, pausing while an unconfirmed
 *   leaf is in view so it can be confirmed. After a full turn with nothing found, **explore**:
 *   drive a short way along the straightest open corridor, then search again.
 * - **approaching**: steer to the nearest reachable confirmed leaf's world position. Turn in place
 *   while it's well off to the side, otherwise drive forward with differential steering.
 * - **collecting**: within reach of the leaf. Stop for `collectMs` (where the arm would pick it up),
 *   then mark it collected and search again.
 *
 * It never drives into a corridor whose clearance is under `stopDistanceM`, and it stops whenever
 * tracking or depth is missing or the depth scan is stale.
 */

import { angleDiffDeg, toRover } from './geometry';
import type { Heading } from './geometry';
import type { TrackedLeaf } from './leaf-map';
import { corridorAt } from './obstacles';
import type { Corridor } from './obstacles';

export type AutopilotConfig = {
  /** Distance to the leaf at which the rover stops to pick it up. */
  arriveM: number;
  /** Wheel speeds, -100..100. */
  maxSpeed: number;
  minSpeed: number;
  turnSpeed: number;
  searchSpeed: number;
  /** Turn in place while the target is further off-axis than this. */
  turnInPlaceDeg: number;
  /** Never drive forward into less clearance than this. */
  stopDistanceM: number;
  /** An explore corridor must be open at least this far. */
  minExploreM: number;
  exploreMs: number;
  collectMs: number;
  /** Depth scans older than this aren't trusted. */
  maxScanAgeMs: number;
};

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  arriveM: 0.35,
  maxSpeed: 55,
  minSpeed: 28,
  turnSpeed: 35,
  searchSpeed: 30,
  turnInPlaceDeg: 25,
  stopDistanceM: 0.45,
  minExploreM: 1.0,
  exploreMs: 2500,
  collectMs: 2500,
  maxScanAgeMs: 1500,
};

export type AutopilotMode = 'searching' | 'exploring' | 'approaching' | 'collecting';

export type AutopilotState = {
  mode: AutopilotMode;
  /** When `mode` started. */
  sinceMs: number;
  targetId?: number;
  /** Degrees turned while searching, to know when a full look-around is done. */
  searchedDeg: number;
  lastYawDeg?: number;
  exploreBearingDeg?: number;
};

export const initialAutopilotState = (nowMs: number): AutopilotState => ({
  mode: 'searching',
  sinceMs: nowMs,
  searchedDeg: 0,
});

export type AutopilotInput = {
  nowMs: number;
  /** Null when tracking isn't normal or the pose is unusable. */
  heading: Heading | null;
  leaves: readonly TrackedLeaf[];
  corridors: readonly Corridor[];
  /** Age of the depth scan the corridors came from; Infinity without one. */
  scanAgeMs: number;
};

export type AutopilotStep = {
  state: AutopilotState;
  left: number;
  right: number;
  /** For the HUD, e.g. "approaching leaf #4 · 1.2 m · 15° right". */
  message: string;
  /** Set on the step a leaf is finished with; the caller marks it collected in the leaf map. */
  collectedId?: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const side = (deg: number) => (Math.abs(deg) < 1 ? 'ahead' : `${Math.abs(Math.round(deg))}° ${deg > 0 ? 'right' : 'left'}`);

function halt(state: AutopilotState, message: string): AutopilotStep {
  return { state, left: 0, right: 0, message };
}

/** Turn in place towards a bearing (+ is right: left wheel forward, right wheel back). */
function turnToward(bearingDeg: number, speed: number) {
  const s = Math.sign(bearingDeg) * speed;
  return { left: s, right: -s };
}

/** Open enough to drive towards: not blocked within `needM` (and never within stopDistanceM). */
function isOpen(lane: Corridor | undefined, needM: number, cfg: AutopilotConfig) {
  if (!lane) return false;
  return lane.blockedBy == null || lane.clearanceM >= Math.max(needM, cfg.stopDistanceM);
}

/** The best leaf to go for: nearest confirmed one whose corridor is open up to it. */
export function chooseTarget(
  leaves: readonly TrackedLeaf[],
  heading: Heading,
  lanes: readonly Corridor[],
  cfg: AutopilotConfig = DEFAULT_AUTOPILOT,
  preferId?: number,
): { leaf: TrackedLeaf; distance: number; bearingDeg: number } | null {
  let best: { leaf: TrackedLeaf; distance: number; bearingDeg: number } | null = null;
  for (const leaf of leaves) {
    if (leaf.state !== 'confirmed') continue;
    const r = toRover(leaf.world, heading);
    // A leaf behind the rover is fine (it turns), but its path is unknown until it's in view.
    const lane = Math.abs(r.bearingDeg) <= 50 ? corridorAt(lanes, r.bearingDeg) : undefined;
    const reachable = Math.abs(r.bearingDeg) > 50 || isOpen(lane, r.distance - cfg.arriveM, cfg);
    if (!reachable) continue;
    // Stick with the current target unless another is clearly nearer, so it doesn't dither.
    const effective = leaf.id === preferId ? r.distance - 0.3 : r.distance;
    if (!best || effective < (best.leaf.id === preferId ? best.distance - 0.3 : best.distance)) {
      best = { leaf, distance: r.distance, bearingDeg: r.bearingDeg };
    }
  }
  return best;
}

export function stepAutopilot(
  state: AutopilotState,
  input: AutopilotInput,
  cfg: AutopilotConfig = DEFAULT_AUTOPILOT,
): AutopilotStep {
  const { nowMs, heading, leaves, corridors: lanes } = input;
  if (!heading) return halt(state, 'Stopped: tracking lost');
  if (!(input.scanAgeMs <= cfg.maxScanAgeMs)) return halt(state, 'Stopped: no fresh LiDAR depth');

  // Collecting: hold still while the leaf is picked up, then move on.
  if (state.mode === 'collecting') {
    if (nowMs - state.sinceMs < cfg.collectMs) {
      return halt(state, `Collecting leaf #${state.targetId}`);
    }
    return {
      state: { ...initialAutopilotState(nowMs), lastYawDeg: heading.yawDeg },
      left: 0,
      right: 0,
      message: `Collected leaf #${state.targetId}`,
      collectedId: state.targetId,
    };
  }

  const target = chooseTarget(leaves, heading, lanes, cfg, state.targetId);
  if (target) {
    const { leaf, distance, bearingDeg } = target;
    const next: AutopilotState = {
      ...state,
      mode: 'approaching',
      sinceMs: state.mode === 'approaching' && state.targetId === leaf.id ? state.sinceMs : nowMs,
      targetId: leaf.id,
      searchedDeg: 0,
    };
    const label = `leaf #${leaf.id} · ${distance.toFixed(1)} m · ${side(bearingDeg)}`;
    if (distance <= cfg.arriveM) {
      return halt({ ...next, mode: 'collecting', sinceMs: nowMs }, `Reached ${label}`);
    }
    const ahead = corridorAt(lanes, 0);
    const blockedAhead = !isOpen(ahead, cfg.stopDistanceM, cfg);
    if (Math.abs(bearingDeg) > cfg.turnInPlaceDeg || blockedAhead) {
      // Facing a wall with the leaf straight ahead shouldn't happen (chooseTarget checked the
      // path), but if it does, turning is still safe.
      const { left, right } = turnToward(bearingDeg || 1, cfg.turnSpeed);
      return { state: next, left, right, message: `Turning to ${label}` };
    }
    const speed = clamp(distance * 70, cfg.minSpeed, cfg.maxSpeed);
    const turn = clamp(bearingDeg / 60, -0.5, 0.5);
    return { state: next, left: speed * (1 + turn), right: speed * (1 - turn), message: `Approaching ${label}` };
  }

  // Exploring: drive along the chosen open corridor for a while.
  if (state.mode === 'exploring' && state.exploreBearingDeg != null && nowMs - state.sinceMs < cfg.exploreMs) {
    const lane = corridorAt(lanes, state.exploreBearingDeg);
    if (isOpen(lane, cfg.minExploreM, cfg)) {
      const turn = clamp(state.exploreBearingDeg / 60, -0.5, 0.5);
      return {
        state,
        left: cfg.minSpeed * (1 + turn),
        right: cfg.minSpeed * (1 - turn),
        message: `Exploring ${side(state.exploreBearingDeg)}`,
      };
    }
  }

  // Searching: turn in place, counting how far, and explore after a full turn.
  let searched = state.mode === 'searching' ? state.searchedDeg : 0;
  if (state.mode === 'searching' && state.lastYawDeg != null) {
    searched += Math.abs(angleDiffDeg(heading.yawDeg, state.lastYawDeg));
  }
  const searching: AutopilotState = {
    mode: 'searching',
    sinceMs: state.mode === 'searching' ? state.sinceMs : nowMs,
    searchedDeg: searched,
    lastYawDeg: heading.yawDeg,
  };
  if (searched >= 360) {
    const open = lanes
      .filter((c) => isOpen(c, cfg.minExploreM, cfg))
      .sort((a, b) => Math.abs(a.bearingDeg) - Math.abs(b.bearingDeg) || b.clearanceM - a.clearanceM)[0];
    if (open) {
      return {
        state: { mode: 'exploring', sinceMs: nowMs, searchedDeg: 0, lastYawDeg: heading.yawDeg, exploreBearingDeg: open.bearingDeg },
        left: 0,
        right: 0,
        message: `Nothing here; exploring ${side(open.bearingDeg)}`,
      };
    }
    searching.searchedDeg = 0;
  }
  const pending = leaves.some((l) => l.state === 'tentative' && nowMs - l.lastSeenMs < 1000);
  if (pending) return halt(searching, 'Checking a possible leaf');
  return { state: searching, left: cfg.searchSpeed, right: -cfg.searchSpeed, message: `Searching · ${Math.round(searched)}°` };
}
