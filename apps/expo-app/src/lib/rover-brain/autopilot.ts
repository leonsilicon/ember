/**
 * Scoop-and-pile autopilot: a pure step function, called a few times a second with the rover's
 * current heading, the leaf map, the corridors and the pile; it returns wheel speeds for `drive()`
 * and where the scoop should be.
 *
 * - **searching**: no leaf to go for. Turn in place to look around, pausing while an unconfirmed
 *   leaf is in view so it can be confirmed. After a full turn with nothing found, **explore**:
 *   drive a short way along the straightest open corridor, then search again (or, with leaves in
 *   the scoop, take them to the pile).
 * - **approaching**: steer to the best confirmed leaf: the nearest, nudged towards ones near the
 *   pile so the trips stay short, and away from ones with something in the way. Leaves in the
 *   pile are never targets.
 * - **aligning**: stopped `alignM` short of the leaf, while it's still in view (closer, it drops
 *   below the camera). Turn until it's dead ahead, then hold still for `settleMs` so detections
 *   from close up refine where it is. If it isn't seen again, it's gone.
 * - **scooping**: lower the scoop and drive straight over the leaf until the scoop's lip is
 *   `scoopPastM` beyond it. The last stretch is blind and steered on the AR pose alone.
 * - **lifting**: raise the scoop. Every leaf the lip swept over is reported collected.
 * - **returning**: once the scoop holds `capacity` loads, drive to the pile.
 *
 * Driving to a leaf or the pile goes straight when the way is open. When it's blocked, the rover
 * detours: it holds the world direction of the open corridor nearest the goal's for `detourMs`,
 * then tries straight again, which works its way round a trunk or a rock.
 * - **dumping**: at the pile's edge, facing it, tip the scoop out.
 * - **backing**: reverse a little, clear of the pile, then search again.
 *
 * It never drives forward into a corridor whose clearance is under `stopDistanceM` (the pile
 * itself excepted when dumping), and it stops whenever tracking or depth is missing or the depth
 * scan is stale.
 */

import { angleDiffDeg, sub, toRover } from './geometry';
import type { Heading, Vec3 } from './geometry';
import type { TrackedLeaf } from './leaf-map';
import { corridorAt } from './obstacles';
import type { Corridor } from './obstacles';

export type AutopilotConfig = {
  /** Stop this far from a leaf to line up the scoop (the leaf must still be in view). */
  alignM: number;
  /** Lined up when the leaf is within this many degrees of dead ahead. */
  alignDeg: number;
  /** Hold still this long once lined up, for close-up sightings of the leaf. */
  settleMs: number;
  /** Give up on a leaf not seen at all for this long while lined up with it. */
  absentMs: number;
  /** How far ahead of the camera the scoop's lip is, lowered. */
  scoopLipM: number;
  /** Width of the scoop's mouth. */
  scoopWidthM: number;
  /** Drive the lip this far past the leaf. */
  scoopPastM: number;
  /** Never drive more than this with the scoop down. */
  scoopMaxM: number;
  /** While scooping, stop if something blocks closer than this. */
  scoopClearM: number;
  lowerMs: number;
  liftMs: number;
  /** Scoop loads it carries before taking them to the pile. */
  capacity: number;
  /** Dump with the camera this far from the pile's centre. */
  dumpAtM: number;
  dumpMs: number;
  backupM: number;
  /** How much a leaf's distance from the pile counts against it, against its distance from the rover. */
  pileWeight: number;
  /** Counted against a leaf with something in the way, in metres of distance. */
  blockedPenaltyM: number;
  /**
   * Counted for the current target, so it only switches to a clearly better leaf. More than
   * `blockedPenaltyM`: turning changes which leaves look blocked, and that mustn't flip the choice.
   */
  stickM: number;
  /** Give up on a leaf not reached in this long. */
  approachMaxMs: number;
  /** Wheel speeds, -100..100. */
  maxSpeed: number;
  minSpeed: number;
  turnSpeed: number;
  /**
   * Turn speed for lining up, scaled down with the angle left to turn, to no less than
   * `minAlignTurnSpeed` (raise that if the motors don't move at it). Too fast and each tick's turn
   * overshoots the ±alignDeg window, back and forth.
   */
  alignTurnSpeed: number;
  minAlignTurnSpeed: number;
  /** Give up on lining up with a leaf after this long. */
  alignMaxMs: number;
  searchSpeed: number;
  scoopSpeed: number;
  backupSpeed: number;
  /** Turn in place while the target is further off-axis than this. */
  turnInPlaceDeg: number;
  /** Never drive forward into less clearance than this. */
  stopDistanceM: number;
  /** Boxed in, reverse this long before turning away. */
  reverseMs: number;
  /** An explore or detour corridor must be open at least this far. */
  minExploreM: number;
  exploreMs: number;
  detourMs: number;
  /** Depth scans older than this aren't trusted. */
  maxScanAgeMs: number;
};

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  alignM: 0.5,
  alignDeg: 5,
  settleMs: 800,
  absentMs: 2500,
  scoopLipM: 0.15,
  scoopWidthM: 0.3,
  scoopPastM: 0.1,
  scoopMaxM: 1,
  scoopClearM: 0.3,
  lowerMs: 500,
  liftMs: 800,
  capacity: 1,
  dumpAtM: 0.6,
  dumpMs: 1500,
  backupM: 0.35,
  pileWeight: 0.5,
  blockedPenaltyM: 2,
  stickM: 2.5,
  approachMaxMs: 90_000,
  maxSpeed: 55,
  minSpeed: 28,
  turnSpeed: 35,
  alignTurnSpeed: 22,
  minAlignTurnSpeed: 10,
  alignMaxMs: 15_000,
  searchSpeed: 30,
  scoopSpeed: 28,
  backupSpeed: 28,
  turnInPlaceDeg: 25,
  stopDistanceM: 0.45,
  minExploreM: 1.0,
  exploreMs: 2500,
  detourMs: 3000,
  reverseMs: 1500,
  maxScanAgeMs: 1500,
};

/** Where the leaves go, set by the user. Leaves within `radiusM` of `center` are in it. */
export type Pile = { center: Vec3; radiusM: number };

export const DEFAULT_PILE_RADIUS_M = 1;

export type ScoopPosition = 'up' | 'down' | 'dump';

export type AutopilotMode =
  | 'searching'
  | 'exploring'
  | 'approaching'
  | 'aligning'
  | 'scooping'
  | 'lifting'
  | 'returning'
  | 'dumping'
  | 'backing';

export type AutopilotState = {
  mode: AutopilotMode;
  /** When `mode` started. */
  sinceMs: number;
  targetId?: number;
  /** Scoop loads carried. */
  load: number;
  /** Degrees turned while searching, to know when a full look-around is done. */
  searchedDeg: number;
  lastYawDeg?: number;
  exploreBearingDeg?: number;
  /** Lined up with the target since then (aligning). */
  alignedAtMs?: number;
  /** Where the camera was when scooping or backing started. */
  startedAt?: Vec3;
  /** Driving along this world yaw until `detourUntilMs`, around something in the way. */
  detourYawDeg?: number;
  detourUntilMs?: number;
  /** Boxed in: reversing until then, before the detour. */
  reverseUntilMs?: number;
};

export const initialAutopilotState = (nowMs: number, load = 0): AutopilotState => ({
  mode: 'searching',
  sinceMs: nowMs,
  load,
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
  pile: Pile | null;
};

export type AutopilotStep = {
  state: AutopilotState;
  left: number;
  right: number;
  scoop: ScoopPosition;
  /** For the HUD, e.g. "Approaching leaf #4 · 1.2 m · 15° right". */
  message: string;
  /** Leaves the scoop just swept up; the caller marks them collected in the leaf map. */
  collectedIds?: number[];
  /** A leaf that wasn't there when the rover got close; also marked collected (gone from the ground). */
  missingId?: number;
  /** A leaf the rover can't get its scoop to; the caller marks it failed. */
  failedId?: number;
  /** Scoop loads just tipped onto the pile. */
  dumped?: number;
};

/** Spread into a state to end any detour. */
const NO_DETOUR = { detourYawDeg: undefined, detourUntilMs: undefined, reverseUntilMs: undefined };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const side = (deg: number) => (Math.abs(deg) < 1 ? 'ahead' : `${Math.abs(Math.round(deg))}° ${deg > 0 ? 'right' : 'left'}`);
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** The scoop is down only while scooping and tipped only while dumping; otherwise it's carried up. */
const scoopFor = (mode: AutopilotMode): ScoopPosition => (mode === 'scooping' ? 'down' : mode === 'dumping' ? 'dump' : 'up');

function out(
  state: AutopilotState,
  left: number,
  right: number,
  message: string,
  extra: Partial<AutopilotStep> = {},
): AutopilotStep {
  return { state, left, right, scoop: scoopFor(state.mode), message, ...extra };
}

function halt(state: AutopilotState, message: string, extra: Partial<AutopilotStep> = {}): AutopilotStep {
  return out(state, 0, 0, message, extra);
}

/** Turn in place towards a bearing (+ is right: left wheel forward, right wheel back). */
function turnToward(bearingDeg: number, speed: number) {
  const s = Math.sign(bearingDeg || 1) * speed;
  return { left: s, right: -s };
}

/** A pivot that slows down for small angles, so a 200 ms tick can't overshoot to the other side. */
function pivot(bearingDeg: number, cfg: AutopilotConfig) {
  return turnToward(bearingDeg, clamp((Math.abs(bearingDeg) / 40) * cfg.turnSpeed, cfg.minAlignTurnSpeed, cfg.turnSpeed));
}

/** A slow turn for lining up, slower the closer it is. */
function fineTurn(bearingDeg: number, cfg: AutopilotConfig) {
  const speed = clamp((Math.abs(bearingDeg) / 20) * cfg.alignTurnSpeed, cfg.minAlignTurnSpeed, cfg.alignTurnSpeed);
  return turnToward(bearingDeg, speed);
}

/** Forward with differential steering towards a bearing. */
function arc(bearingDeg: number, speed: number, maxTurn = 0.5) {
  const turn = clamp(bearingDeg / 60, -maxTurn, maxTurn);
  return { left: speed * (1 + turn), right: speed * (1 - turn) };
}

/** Open enough to drive towards: not blocked within `needM` (and never within stopDistanceM). */
function isOpen(lane: Corridor | undefined, needM: number, cfg: AutopilotConfig) {
  if (!lane) return false;
  return lane.blockedBy == null || lane.clearanceM >= Math.max(needM, cfg.stopDistanceM);
}

/**
 * Clear to arc towards `bearingDeg`: every corridor from straight ahead round to a step beyond it
 * is open past `stopDistanceM`. An arc sweeps the body through all of them, not just the goal's.
 */
function arcOpen(lanes: readonly Corridor[], bearingDeg: number, cfg: AutopilotConfig) {
  const lo = Math.min(0, bearingDeg) - 4;
  const hi = Math.max(0, bearingDeg) + 4;
  return lanes.every((c) => c.bearingDeg < lo || c.bearingDeg > hi || isOpen(c, cfg.stopDistanceM, cfg));
}

export function inPile(world: Vec3, pile: Pile | null) {
  return pile != null && horizontal(world, pile.center) <= pile.radiusM;
}

/**
 * The best leaf to go for: a confirmed one outside the pile, the nearest after adding
 * `pileWeight` × its distance from the pile, and `blockedPenaltyM` if its corridor is blocked
 * before it. A blocked leaf is still worth a detour when there's nothing better.
 */
export function chooseTarget(
  leaves: readonly TrackedLeaf[],
  heading: Heading,
  lanes: readonly Corridor[],
  cfg: AutopilotConfig = DEFAULT_AUTOPILOT,
  preferId?: number,
  pile: Pile | null = null,
): { leaf: TrackedLeaf; distance: number; bearingDeg: number } | null {
  let best: { leaf: TrackedLeaf; distance: number; bearingDeg: number; cost: number } | null = null;
  for (const leaf of leaves) {
    if (leaf.state !== 'confirmed' || inPile(leaf.world, pile)) continue;
    const r = toRover(leaf.world, heading);
    // A leaf behind the rover is fine (it turns), but its path is unknown until it's in view.
    const lane = Math.abs(r.bearingDeg) <= 50 ? corridorAt(lanes, r.bearingDeg) : undefined;
    const blocked = Math.abs(r.bearingDeg) <= 50 && !isOpen(lane, r.distance - cfg.alignM, cfg);
    // Stick with the current target unless another is clearly better, so it doesn't dither.
    const cost =
      r.distance +
      (pile ? cfg.pileWeight * horizontal(leaf.world, pile.center) : 0) +
      (blocked ? cfg.blockedPenaltyM : 0) -
      (leaf.id === preferId ? cfg.stickM : 0);
    if (!best || cost < best.cost) best = { leaf, distance: r.distance, bearingDeg: r.bearingDeg, cost };
  }
  return best && { leaf: best.leaf, distance: best.distance, bearingDeg: best.bearingDeg };
}

/** Confirmed or tentative leaves the scoop's lip passed over, driving from `start` to `heading.origin`. */
export function sweptLeaves(
  leaves: readonly TrackedLeaf[],
  start: Vec3,
  heading: Heading,
  cfg: AutopilotConfig = DEFAULT_AUTOPILOT,
) {
  const travelled = horizontal(heading.origin, start);
  const d = sub(heading.origin, start);
  const dir = travelled > 0.05 ? [d[0] / travelled, d[2] / travelled] : [heading.forward[0], heading.forward[2]];
  return leaves
    .filter((leaf) => {
      if (leaf.state !== 'confirmed' && leaf.state !== 'tentative') return false;
      const x = leaf.world[0] - start[0];
      const z = leaf.world[2] - start[2];
      const along = x * dir[0] + z * dir[1];
      const across = x * dir[1] - z * dir[0];
      return along >= cfg.scoopLipM && along <= travelled + cfg.scoopLipM && Math.abs(across) <= cfg.scoopWidthM / 2;
    })
    .map((leaf) => leaf.id);
}

export function stepAutopilot(
  state: AutopilotState,
  input: AutopilotInput,
  cfg: AutopilotConfig = DEFAULT_AUTOPILOT,
): AutopilotStep {
  const { heading } = input;
  if (!heading) return halt(state, 'Stopped: tracking lost');
  if (!(input.scanAgeMs <= cfg.maxScanAgeMs)) return halt(state, 'Stopped: no fresh LiDAR depth');
  switch (state.mode) {
    case 'aligning':
      return align(state, input, heading, cfg);
    case 'scooping':
      return scoop(state, input, heading, cfg);
    case 'lifting':
      return lift(state, input, heading, cfg);
    case 'returning':
      return returnToPile(state, input, heading, cfg);
    case 'dumping':
      return dump(state, input, heading, cfg);
    case 'backing':
      return backUp(state, input, heading, cfg);
    default:
      return seek(state, input, heading, cfg);
  }
}

/** Searching, exploring and approaching: find a leaf and drive to within `alignM` of it. */
function seek(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs, leaves, corridors: lanes, pile } = input;
  if (state.load >= cfg.capacity) {
    return pile
      ? returnToPile({ ...state, mode: 'returning', sinceMs: nowMs }, input, heading, cfg)
      : halt(state, 'Scoop full: set a pile');
  }

  // Mid-detour, stick with the leaf it's going round to; switching would start over.
  const detouring = state.mode === 'approaching' && state.detourUntilMs != null && nowMs < state.detourUntilMs;
  const current = detouring ? leaves.find((l) => l.id === state.targetId && l.state === 'confirmed') : undefined;
  const target = current
    ? { leaf: current, ...toRover(current.world, heading) }
    : chooseTarget(leaves, heading, lanes, cfg, state.targetId, pile);
  if (target) {
    const { leaf, distance, bearingDeg } = target;
    const same = state.mode === 'approaching' && state.targetId === leaf.id;
    const next: AutopilotState = {
      ...state,
      mode: 'approaching',
      sinceMs: same ? state.sinceMs : nowMs,
      targetId: leaf.id,
      searchedDeg: 0,
      ...(same ? {} : NO_DETOUR),
    };
    const label = `leaf #${leaf.id} · ${distance.toFixed(1)} m · ${side(bearingDeg)}`;
    if (nowMs - next.sinceMs > cfg.approachMaxMs) {
      return halt(initialAutopilotState(nowMs, state.load), `Can't get to leaf #${leaf.id}; giving up on it`, {
        failedId: leaf.id,
      });
    }
    if (distance <= cfg.alignM) {
      return halt({ ...next, mode: 'aligning', sinceMs: nowMs, alignedAtMs: undefined, ...NO_DETOUR }, `Reached ${label}`);
    }
    return navigate(next, leaf.world, cfg.alignM, 0, label, input, heading, cfg);
  }

  // Exploring: drive along the chosen open corridor for a while.
  if (state.mode === 'exploring' && state.exploreBearingDeg != null && nowMs - state.sinceMs < cfg.exploreMs) {
    const lane = corridorAt(lanes, state.exploreBearingDeg);
    if (isOpen(lane, cfg.minExploreM, cfg)) {
      const { left, right } = arc(state.exploreBearingDeg, cfg.minSpeed);
      return out(state, left, right, `Exploring ${side(state.exploreBearingDeg)}`);
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
    load: state.load,
    searchedDeg: searched,
    lastYawDeg: heading.yawDeg,
  };
  if (searched >= 360) {
    // Nothing more around here: empty a part-full scoop before wandering off.
    if (state.load > 0 && pile) {
      return halt({ ...searching, mode: 'returning', sinceMs: nowMs, searchedDeg: 0 }, 'No more leaves here; to the pile');
    }
    const open = lanes
      .filter((c) => isOpen(c, cfg.minExploreM, cfg))
      .sort((a, b) => Math.abs(a.bearingDeg) - Math.abs(b.bearingDeg) || b.clearanceM - a.clearanceM)[0];
    if (open) {
      return halt(
        { ...searching, mode: 'exploring', sinceMs: nowMs, searchedDeg: 0, exploreBearingDeg: open.bearingDeg },
        `Nothing here; exploring ${side(open.bearingDeg)}`,
      );
    }
    searching.searchedDeg = 0;
  }
  const pending = leaves.some((l) => l.state === 'tentative' && nowMs - l.lastSeenMs < 1000 && !inPile(l.world, pile));
  if (pending) return halt(searching, 'Checking a possible leaf');
  return out(searching, cfg.searchSpeed, -cfg.searchSpeed, `Searching · ${Math.round(searched)}°`);
}

/** Stopped short of the leaf: face it squarely and let close-up sightings settle its position. */
function align(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs, leaves, corridors: lanes } = input;
  const leaf = leaves.find((l) => l.id === state.targetId);
  if (!leaf || leaf.state !== 'confirmed') return seek({ ...state, mode: 'searching', sinceMs: nowMs }, input, heading, cfg);
  const r = toRover(leaf.world, heading);
  // The leaf's estimate moved away (close-up sightings are better), so close in again.
  if (r.distance > cfg.alignM + 0.3) return seek({ ...state, mode: 'approaching' }, input, heading, cfg);
  const label = `leaf #${leaf.id}`;
  if (nowMs - state.sinceMs > cfg.alignMaxMs) {
    return halt(initialAutopilotState(nowMs, state.load), `Couldn't line up ${label}; giving up on it`, { failedId: leaf.id });
  }
  if (Math.abs(r.bearingDeg) > cfg.alignDeg) {
    const { left, right } = fineTurn(r.bearingDeg, cfg);
    return out({ ...state, alignedAtMs: undefined }, left, right, `Lining up ${label} · ${side(r.bearingDeg)}`);
  }
  const alignedAtMs = state.alignedAtMs ?? nowMs;
  const lined = { ...state, alignedAtMs };
  if (nowMs - alignedAtMs < cfg.settleMs) return halt(lined, `Lining up ${label}`);
  if (leaf.lastSeenMs < alignedAtMs) {
    // It's right in front of the camera, so it should have been seen again by now.
    if (nowMs - alignedAtMs < cfg.absentMs) return halt(lined, `Looking for ${label}`);
    return halt(initialAutopilotState(nowMs, state.load), `${label} isn't there any more`, { missingId: leaf.id });
  }
  const travel = r.forward - cfg.scoopLipM + cfg.scoopPastM;
  const ahead = corridorAt(lanes, 0);
  if (ahead && ahead.blockedBy != null && ahead.clearanceM < travel + cfg.scoopClearM) {
    return halt(initialAutopilotState(nowMs, state.load), `Can't scoop ${label}: something behind it`, { failedId: leaf.id });
  }
  return halt({ ...lined, mode: 'scooping', sinceMs: nowMs, startedAt: heading.origin }, `Scooping ${label}`);
}

/** Scoop down, straight over the leaf until the lip is past it. */
function scoop(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs, leaves, corridors: lanes } = input;
  const label = `leaf #${state.targetId}`;
  if (nowMs - state.sinceMs < cfg.lowerMs) return halt(state, `Lowering the scoop for ${label}`);
  const start = state.startedAt ?? heading.origin;
  const travelled = horizontal(heading.origin, start);
  const leaf = leaves.find((l) => l.id === state.targetId);
  const r = leaf ? toRover(leaf.world, heading) : null;
  const passed = !r || r.forward <= cfg.scoopLipM - cfg.scoopPastM;
  const ahead = corridorAt(lanes, 0);
  const blocked = ahead != null && ahead.blockedBy != null && ahead.clearanceM < cfg.scoopClearM;
  if (passed || blocked || travelled >= cfg.scoopMaxM) {
    const collectedIds = sweptLeaves(leaves, start, heading, cfg);
    return halt({ ...state, mode: 'lifting', sinceMs: nowMs }, blocked ? `Blocked; lifting the scoop` : `Lifting ${label}`, {
      collectedIds,
    });
  }
  // Steer only while the leaf is well in front: right under the camera its bearing swings wildly.
  const bearing = r && r.forward > cfg.scoopLipM + 0.1 ? r.bearingDeg : 0;
  const { left, right } = arc(bearing, cfg.scoopSpeed, 0.3);
  return out(state, left, right, `Scooping ${label}`);
}

function lift(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs, pile } = input;
  if (nowMs - state.sinceMs < cfg.liftMs) return halt(state, 'Lifting the scoop');
  const load = state.load + 1;
  if (load >= cfg.capacity) {
    return pile
      ? halt({ ...initialAutopilotState(nowMs, load), mode: 'returning' }, 'Scoop full; to the pile')
      : halt(initialAutopilotState(nowMs, load), 'Scoop full: set a pile');
  }
  return halt({ ...initialAutopilotState(nowMs, load), lastYawDeg: heading.yawDeg }, `Scooped (${load}/${cfg.capacity})`);
}

/** Drive to the pile's edge, facing its centre. */
function returnToPile(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs, corridors: lanes, pile } = input;
  if (!pile) return halt(state, 'Scoop full: set a pile');
  const r = toRover(pile.center, heading);
  const label = `pile · ${r.distance.toFixed(1)} m · ${side(r.bearingDeg)}`;
  const ahead = corridorAt(lanes, 0);
  // The pile itself shows up in the depth once it's grown; this close, what blocks is the pile.
  const pileAhead = r.distance <= pile.radiusM + cfg.stopDistanceM && !isOpen(ahead, cfg.stopDistanceM, cfg);
  const arrived = r.distance <= cfg.dumpAtM || pileAhead;
  if (arrived && Math.abs(r.bearingDeg) <= cfg.alignDeg * 2) {
    return halt({ ...state, mode: 'dumping', sinceMs: nowMs, ...NO_DETOUR }, 'Dumping onto the pile');
  }
  if (arrived) {
    const { left, right } = fineTurn(r.bearingDeg, cfg);
    return out({ ...state, ...NO_DETOUR }, left, right, `Turning to the ${label}`);
  }
  return navigate(state, pile.center, cfg.dumpAtM, pile.radiusM, `the ${label}`, input, heading, cfg);
}

/**
 * One step towards `goal`, to stop `stopAtM` from it: turn to face it, drive straight while the way
 * is open, and detour while it isn't. Blocking within `goalRadiusM` of the goal is the goal itself
 * (the pile), not in the way.
 */
function navigate(
  state: AutopilotState,
  goal: Vec3,
  stopAtM: number,
  goalRadiusM: number,
  label: string,
  input: AutopilotInput,
  heading: Heading,
  cfg: AutopilotConfig,
): AutopilotStep {
  const { nowMs, corridors: lanes } = input;
  const r = toRover(goal, heading);
  if (state.reverseUntilMs != null && nowMs < state.reverseUntilMs) {
    // Blind, but back over the ground it just drove.
    return out(state, -cfg.backupSpeed, -cfg.backupSpeed, `Boxed in; backing up from ${label}`);
  }
  const detouring = state.detourYawDeg != null && state.detourUntilMs != null && nowMs < state.detourUntilMs;
  const direct: AutopilotState = { ...state, ...NO_DETOUR };

  if (!detouring) {
    if (Math.abs(r.bearingDeg) > cfg.turnInPlaceDeg) {
      const { left, right } = pivot(r.bearingDeg, cfg);
      return out(direct, left, right, `Turning to ${label}`);
    }
    const lane = corridorAt(lanes, r.bearingDeg);
    const open =
      isOpen(lane, r.distance - stopAtM, cfg) ||
      (goalRadiusM > 0 && lane?.blockedBy != null && lane.clearanceM >= r.distance - goalRadiusM);
    if (open && !arcOpen(lanes, r.bearingDeg, cfg)) {
      // The way is open but an arc would clip something on the way round: pivot, then go straight.
      const { left, right } = pivot(r.bearingDeg, cfg);
      return out(direct, left, right, `Turning to ${label}`);
    }
    if (open) {
      // Slow down into the stop, so it ends up close to stopAtM, not past it.
      const speed = clamp((r.distance - stopAtM) * 70 + cfg.minSpeed * 0.5, cfg.minSpeed, cfg.maxSpeed);
      const { left, right } = arc(r.bearingDeg, speed);
      return out(direct, left, right, `To ${label}`);
    }
  } else {
    const bearing = angleDiffDeg(state.detourYawDeg!, heading.yawDeg);
    // Pivot onto the detour; also when it's only slightly off but an arc would clip something.
    if (Math.abs(bearing) > cfg.turnInPlaceDeg || !arcOpen(lanes, bearing, cfg)) {
      const { left, right } = pivot(bearing, cfg);
      return out(state, left, right, `Detouring to ${label}`);
    }
    if (isOpen(corridorAt(lanes, bearing), cfg.minExploreM, cfg)) {
      const { left, right } = arc(bearing, cfg.minSpeed);
      return out(state, left, right, `Detouring to ${label}`);
    }
  }

  // Blocked: take the open corridor nearest the goal's direction, as a world direction, for a while.
  const best = lanes
    .filter((c) => isOpen(c, cfg.minExploreM, cfg))
    .sort((a, b) => Math.abs(a.bearingDeg - r.bearingDeg) - Math.abs(b.bearingDeg - r.bearingDeg))[0];
  if (best) {
    return halt(
      { ...state, detourYawDeg: heading.yawDeg + best.bearingDeg, detourUntilMs: nowMs + cfg.detourMs },
      `Way to ${label} blocked; detouring ${side(best.bearingDeg)}`,
    );
  }
  // Boxed in ahead: back up a little, then commit to turning side-on, towards the side of the fan
  // with more room, so it doesn't flip-flop with a goal that's nearly dead ahead.
  const room = (sign: number) => lanes.filter((c) => Math.sign(c.bearingDeg) === sign).reduce((sum, c) => sum + c.clearanceM, 0);
  const turn = room(1) >= room(-1) ? 1 : -1;
  return halt(
    {
      ...state,
      reverseUntilMs: nowMs + cfg.reverseMs,
      detourYawDeg: heading.yawDeg + turn * 90,
      detourUntilMs: nowMs + cfg.reverseMs + cfg.detourMs,
    },
    `Boxed in on the way to ${label}; backing up, then ${turn > 0 ? 'right' : 'left'}`,
  );
}

function dump(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs } = input;
  if (nowMs - state.sinceMs < cfg.dumpMs) return halt(state, 'Dumping onto the pile');
  return halt(
    { ...initialAutopilotState(nowMs), mode: 'backing', startedAt: heading.origin },
    `Dumped ${state.load} scoop${state.load === 1 ? '' : 's'}`,
    { dumped: state.load },
  );
}

/** Straight back off the pile. Blind (the camera faces forward), but only over ground it just drove. */
function backUp(state: AutopilotState, input: AutopilotInput, heading: Heading, cfg: AutopilotConfig): AutopilotStep {
  const { nowMs } = input;
  const travelled = horizontal(heading.origin, state.startedAt ?? heading.origin);
  // Time-limited too, in case the wheels spin without moving it.
  if (travelled >= cfg.backupM || nowMs - state.sinceMs > 4000) {
    return halt({ ...initialAutopilotState(nowMs), lastYawDeg: heading.yawDeg }, 'Backed off the pile');
  }
  return out(state, -cfg.backupSpeed, -cfg.backupSpeed, 'Backing off the pile');
}
