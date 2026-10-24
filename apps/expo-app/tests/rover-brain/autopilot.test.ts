import { describe, expect, test } from 'bun:test';

import { DEFAULT_AUTOPILOT, initialAutopilotState, stepAutopilot } from '../../src/lib/rover-brain/autopilot';
import { headingFromPose, type Vec3 } from '../../src/lib/rover-brain/geometry';
import type { TrackedLeaf } from '../../src/lib/rover-brain/leaf-map';
import { CORRIDOR_BEARINGS, type Corridor } from '../../src/lib/rover-brain/obstacles';
import { pose } from './scene';

const clear: Corridor[] = CORRIDOR_BEARINGS.map((b) => ({ bearingDeg: b, clearanceM: 5, blockedBy: null, observedM: 3 }));
const blockedAt = (bearings: number[], clearanceM: number): Corridor[] =>
  clear.map((c) => (bearings.includes(c.bearingDeg) ? { ...c, clearanceM, blockedBy: 'obstacle' } : c));

function leaf(id: number, world: Vec3, state: TrackedLeaf['state'] = 'confirmed', lastSeenMs = 0): TrackedLeaf {
  return { id, world, label: 'dry leaf', score: 0.3, hits: 3, state, source: 'lidar', firstSeenMs: 0, lastSeenMs };
}

const heading = headingFromPose(pose([0, 0.3, 0], 20, 0))!;
const input = (leaves: TrackedLeaf[], corridors = clear, nowMs = 1000) => ({ nowMs, heading, leaves, corridors, scanAgeMs: 100 });

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

  test('stops to collect within reach, then reports the leaf collected', () => {
    let step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0, 0, -0.2])], clear, 1000));
    expect(step.state.mode).toBe('collecting');
    expect([step.left, step.right]).toEqual([0, 0]);
    step = stepAutopilot(step.state, input([leaf(1, [0, 0, -0.2])], clear, 1000 + DEFAULT_AUTOPILOT.collectMs - 1));
    expect(step.collectedId).toBeUndefined();
    step = stepAutopilot(step.state, input([leaf(1, [0, 0, -0.2])], clear, 1000 + DEFAULT_AUTOPILOT.collectMs + 1));
    expect(step.collectedId).toBe(1);
    expect(step.state.mode).toBe('searching');
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
    const step = stepAutopilot(initialAutopilotState(0), input([leaf(1, [0.1, 0, -3])], blockedAt([0], 0.3)));
    expect(Math.sign(step.left)).toBe(-Math.sign(step.right));
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
