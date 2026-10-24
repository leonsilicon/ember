import { describe, expect, test } from 'bun:test';

import {
  chooseTarget,
  DEFAULT_AUTOPILOT,
  initialAutopilotState,
  stepAutopilot,
  sweptLeaves,
  type AutopilotState,
  type Pile,
} from '../../src/lib/rover-brain/autopilot';
import { angleDiffDeg, headingFromPose, type Vec3 } from '../../src/lib/rover-brain/geometry';
import type { TrackedLeaf } from '../../src/lib/rover-brain/leaf-map';
import { CORRIDOR_BEARINGS, type Corridor } from '../../src/lib/rover-brain/obstacles';
import { pose } from './scene';

const clear: Corridor[] = CORRIDOR_BEARINGS.map((b) => ({ bearingDeg: b, clearanceM: 5, blockedBy: null, observedM: 3 }));
const blockedAt = (bearings: number[], clearanceM: number): Corridor[] =>
  clear.map((c) => (bearings.includes(c.bearingDeg) ? { ...c, clearanceM, blockedBy: 'obstacle' } : c));

function leaf(id: number, world: Vec3, state: TrackedLeaf['state'] = 'confirmed', lastSeenMs = 0): TrackedLeaf {
  return { id, world, label: 'dry leaf', score: 0.3, hits: 3, state, source: 'lidar', firstSeenMs: 0, lastSeenMs, attempts: 0, missHits: 0 };
}

const pile: Pile = { center: [0, 0, 2], radiusM: 1 };

const heading = headingFromPose(pose([0, 0.3, 0], 20, 0))!;
const input = (leaves: TrackedLeaf[], corridors = clear, nowMs = 1000, p: Pile | null = pile) => ({
  nowMs,
  heading,
  leaves,
  corridors,
  scanAgeMs: 100,
  pile: p,
});
const cfg = DEFAULT_AUTOPILOT;
/** The rover at `position` facing `yawDeg`. */
const at = (position: Vec3, yawDeg = 0) => headingFromPose(pose(position, 20, yawDeg))!;

describe('autopilot', () => {
  test('drives forward towards a leaf ahead, steering slightly right for one a bit right', () => {
    const step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0.2, 0, -2])]));
    expect(step.state.mode).toBe('approaching');
    expect(step.state.targetId).toBe(1);
    expect(step.left).toBeGreaterThan(step.right);
    expect(step.right).toBeGreaterThan(0);
  });

  test('turns in place towards a leaf well to the left', () => {
    const step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [-1.5, 0, -0.5])]));
    expect(step.left).toBeLessThan(0);
    expect(step.right).toBeGreaterThan(0);
    expect(step.right).toBe(-step.left);
  });

  test('stops short of the leaf to line up, scoop up', () => {
    const step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0, 0, -0.45])]));
    expect(step.state.mode).toBe('aligning');
    expect([step.left, step.right, step.scoop]).toEqual([0, 0, 'up']);
  });

  test('lines up by turning slowly, then waits for a close-up sighting before scooping', () => {
    const aligning: AutopilotState = { ...initialAutopilotState(0), mode: 'aligning', targetId: 1 };
    // 10° right: turn right, slowly.
    let step = stepAutopilot(aligning, input([leaf(1, [0.08, 0, -0.45], 'confirmed', 900)]));
    expect(step.left).toBeGreaterThanOrEqual(cfg.minAlignTurnSpeed);
    expect(step.left).toBeLessThan(cfg.alignTurnSpeed);
    expect(step.right).toBe(-step.left);
    // Dead ahead: hold still for settleMs.
    step = stepAutopilot(aligning, input([leaf(1, [0, 0, -0.45], 'confirmed', 900)], clear, 1000));
    expect(step.state.alignedAtMs).toBe(1000);
    expect([step.left, step.right]).toEqual([0, 0]);
    // Seen again since: scoop.
    step = stepAutopilot(step.state, input([leaf(1, [0, 0, -0.45], 'confirmed', 1500)], clear, 1000 + cfg.settleMs));
    expect(step.state.mode).toBe('scooping');
    expect(step.scoop).toBe('down');
  });

  test("reports a leaf missing when it isn't seen again close up", () => {
    const aligning: AutopilotState = { ...initialAutopilotState(0), mode: 'aligning', targetId: 1, alignedAtMs: 1000 };
    const stale = [leaf(1, [0, 0, -0.45], 'confirmed', 500)];
    expect(stepAutopilot(aligning, input(stale, clear, 1000 + cfg.settleMs)).missingId).toBeUndefined();
    const step = stepAutopilot(aligning, input(stale, clear, 1000 + cfg.absentMs));
    expect(step.missingId).toBe(1);
    expect(step.state.mode).toBe('searching');
  });

  test('scoops: lowers, drives straight over the leaf, then lifts and reports what the lip swept', () => {
    const start = at([0, 0.3, 0]);
    const leaves = [leaf(1, [0, 0, -0.5]), leaf(2, [0.1, 0, -0.55]), leaf(3, [0.4, 0, -0.5])];
    let state: AutopilotState = { ...initialAutopilotState(0), mode: 'scooping', sinceMs: 0, targetId: 1, startedAt: start.origin };
    let step = stepAutopilot(state, { ...input(leaves, clear, cfg.lowerMs - 1), heading: start });
    expect([step.left, step.right, step.scoop]).toEqual([0, 0, 'down']);
    step = stepAutopilot(state, { ...input(leaves, clear, cfg.lowerMs + 1), heading: start });
    expect(step.left).toBe(cfg.scoopSpeed);
    expect(step.right).toBe(cfg.scoopSpeed);
    // The lip (scoopLipM ahead of the camera) is now scoopPastM beyond leaf 1.
    const past = at([0, 0.3, -0.5 - cfg.scoopPastM - 0.01 + cfg.scoopLipM]);
    step = stepAutopilot(step.state, { ...input(leaves, clear, 3000), heading: past });
    expect(step.state.mode).toBe('lifting');
    expect(step.collectedIds).toEqual([1, 2]); // leaf 3 is 40 cm to the side, outside the scoop
    state = step.state;
    // One scoop fills a one-scoop bin: off to the pile.
    step = stepAutopilot(state, { ...input(leaves, clear, 3000 + cfg.liftMs + 1), heading: past }, { ...cfg, capacity: 1 });
    expect(step.state.mode).toBe('returning');
    expect(step.state.load).toBe(1);
    expect(step.scoop).toBe('up');
  });

  test('fills the bin (4 scoops by default) before going to the pile', () => {
    expect(cfg.capacity).toBe(4);
    const lifting = (load: number): AutopilotState => ({ ...initialAutopilotState(0, load), mode: 'lifting', sinceMs: 0 });
    let step = stepAutopilot(lifting(0), input([], clear, cfg.liftMs + 1));
    expect(step.state.mode).toBe('searching');
    expect(step.state.load).toBe(1);
    step = stepAutopilot(lifting(3), input([], clear, cfg.liftMs + 1));
    expect(step.state.mode).toBe('returning');
    expect(step.state.load).toBe(4);
  });

  test('empties a part-full bin once a full look round finds nothing more', () => {
    let state: AutopilotState = { ...initialAutopilotState(0, 2), lastYawDeg: 0 };
    for (let yaw = 30; yaw <= 390 && state.mode === 'searching'; yaw += 30) {
      state = stepAutopilot(state, { ...input([], clear, 1000 + yaw), heading: at([0, 0.3, 0], yaw) }).state;
    }
    expect(state.mode).toBe('returning');
    expect(state.load).toBe(2);
  });

  test('stops scooping when something is right ahead', () => {
    const state: AutopilotState = { ...initialAutopilotState(0), mode: 'scooping', sinceMs: 0, targetId: 1, startedAt: heading.origin };
    const step = stepAutopilot(state, input([leaf(1, [0, 0, -0.4])], blockedAt([0], 0.2), cfg.lowerMs + 1));
    expect(step.state.mode).toBe('lifting');
  });

  test('a full scoop goes to the pile, dumps facing it, and backs off', () => {
    const full: AutopilotState = { ...initialAutopilotState(0, 1), mode: 'returning' };
    // Pile behind: turn round first.
    let step = stepAutopilot(full, input([leaf(1, [0, 0, -1])]));
    expect(step.state.mode).toBe('returning');
    expect(Math.sign(step.left)).toBe(-Math.sign(step.right));
    // Facing it, 2 m away: drive.
    const facing = at([0, 0.3, 0], 180);
    step = stepAutopilot(full, { ...input([]), heading: facing });
    expect(step.left).toBeGreaterThan(0);
    expect(step.right).toBeGreaterThan(0);
    // At the dump point: tip the scoop.
    const there = at([0, 0.3, 2 - cfg.dumpAtM + 0.05], 180);
    step = stepAutopilot(full, { ...input([]), heading: there });
    expect(step.state.mode).toBe('dumping');
    step = stepAutopilot(step.state, { ...input([], clear, 1000), heading: there });
    expect(step.scoop).toBe('dump');
    step = stepAutopilot(step.state, { ...input([], clear, 1000 + cfg.dumpMs + 1), heading: there });
    expect(step.dumped).toBe(1);
    expect(step.state.load).toBe(0);
    expect(step.state.mode).toBe('backing');
    step = stepAutopilot(step.state, { ...input([], clear, 3000), heading: there });
    expect(step.left).toBe(-cfg.backupSpeed);
    const backed = at([0, 0.3, 2 - cfg.dumpAtM + 0.05 - cfg.backupM - 0.01], 180);
    step = stepAutopilot(step.state, { ...input([], clear, 4000), heading: backed });
    expect(step.state.mode).toBe('searching');
  });

  test('dumps where the grown pile blocks the way, short of the dump point', () => {
    const full: AutopilotState = { ...initialAutopilotState(0, 1), mode: 'returning' };
    const near = at([0, 0.3, 2 - 1.2], 180);
    const step = stepAutopilot(full, { ...input([], blockedAt([-7.5, 0, 7.5], 0.4)), heading: near });
    expect(step.state.mode).toBe('dumping');
  });

  test('detours round something between it and the pile', () => {
    const full: AutopilotState = { ...initialAutopilotState(0, 1), mode: 'returning' };
    const facing = at([0, 0.3, 0], 180);
    let step = stepAutopilot(full, { ...input([], blockedAt([-7.5, 0, 7.5, 15], 0.6), 1000), heading: facing });
    expect(step.state.detourYawDeg).toBeDefined();
    expect(angleDiffDeg(step.state.detourYawDeg!, 180)).toBe(-15); // the open lane nearest the pile's
    // Turned onto the detour (corridors are relative to the rover, so that lane is now ahead).
    step = stepAutopilot(step.state, { ...input([], clear, 1200), heading: at([0, 0.3, 0], 165) });
    expect(step.left).toBeGreaterThan(0);
    expect(step.right).toBeGreaterThan(0);
  });

  test("never targets leaves in the pile, and doesn't scoop more without one", () => {
    const step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0, 0, 1.5])]));
    expect(step.state.targetId).toBeUndefined();
    const full = stepAutopilot(initialAutopilotState(0, cfg.capacity), input([leaf(2, [0, 0, -2])], clear, 1000, null));
    expect(full.message).toMatch(/set a pile/);
    expect([full.left, full.right]).toEqual([0, 0]);
  });

  test('prefers leaves nearer the pile, all else equal', () => {
    // Both 2 m from the rover; one towards the pile.
    const towards = leaf(1, [1.414, 0, 1.414]);
    const away = leaf(2, [1.414, 0, -1.414]);
    expect(chooseTarget([away, towards], heading, clear, cfg, undefined, pile)!.leaf.id).toBe(1);
  });

  test('sweptLeaves only counts leaves the lip passed over', () => {
    const swept = sweptLeaves([leaf(1, [0, 0, -0.3]), leaf(2, [0, 0, -0.05]), leaf(3, [0, 0, -0.9])], [0, 0.3, 0], at([0, 0.3, -0.5]));
    expect(swept).toEqual([1]);
  });

  test('gives up on a leaf it can not reach in time', () => {
    const state: AutopilotState = { ...initialAutopilotState(0), mode: 'approaching', sinceMs: 0, targetId: 1 };
    const step = stepAutopilot(state, input([leaf(1, [0, 0, -2])], clear, cfg.approachMaxMs + 1));
    expect(step.failedId).toBe(1);
  });

  test('skips a leaf behind an obstacle for a reachable one', () => {
    const blocked = leaf(1, [0, 0, -2]);
    const reachable = leaf(2, [-1.8, 0, -2.2]);
    const step = stepAutopilot(initialAutopilotState(0), input([blocked, reachable], blockedAt([0, -7.5, 7.5], 1)));
    expect(step.state.targetId).toBe(2);
  });

  test('ignores tentative and collected leaves', () => {
    const step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0, 0, -1], 'tentative', 900), leaf(2, [0, 0, -1.5], 'collected')]));
    expect(step.state.mode).toBe('searching');
    expect([step.left, step.right]).toEqual([0, 0]); // pausing on the just-seen tentative leaf
    const later = stepAutopilot(step.state, input([leaf(1, [0, 0, -1], 'tentative', 0)]));
    expect(later.left).toBe(DEFAULT_AUTOPILOT.searchSpeed); // not seen lately: keep searching
  });

  test('never drives forward into a blocked corridor', () => {
    let step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0.1, 0, -3])], blockedAt([0], 0.3)));
    for (let t = 1200; t < 5000; t += 200) {
      expect(step.left > 0 && step.right > 0 && Math.abs(step.left - step.right) < 20).toBe(false);
      step = stepAutopilot(step.state, input([leaf(1, [0.1, 0, -3])], blockedAt([0], 0.3), t));
    }
  });

  test('stops without tracking or fresh depth', () => {
    const state = initialAutopilotState(0);
    expect(stepAutopilot(state, { ...input([leaf(1, [0, 0, -2])]), heading: null })).toMatchObject({ left: 0, right: 0 });
    expect(stepAutopilot(state, { ...input([leaf(1, [0, 0, -2])]), scanAgeMs: Infinity })).toMatchObject({ left: 0, right: 0 });
  });

  test('searches by turning, then explores after a full turn', () => {
    let state = initialAutopilotState(0);
    let step = stepAutopilot(state, input([]));
    expect(step.left).toBe(DEFAULT_AUTOPILOT.searchSpeed);
    expect(step.right).toBe(-DEFAULT_AUTOPILOT.searchSpeed);
    state = step.state;
    for (let yaw = 30; yaw <= 390; yaw += 30) {
      const h = headingFromPose(pose([0, 0.3, 0], 20, yaw))!;
      step = stepAutopilot(state, { ...input([]), heading: h, nowMs: 1000 + yaw });
      state = step.state;
      if (state.mode === 'exploring') break;
    }
    expect(state.mode).toBe('exploring');
    expect(state.exploreBearingDeg).toBe(0);
    step = stepAutopilot(state, { ...input([]), nowMs: state.sinceMs + 100 });
    expect(step.left).toBeGreaterThan(0);
    expect(step.right).toBeGreaterThan(0);
  });
});
