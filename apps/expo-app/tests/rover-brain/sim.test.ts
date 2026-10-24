import { describe, expect, test } from 'bun:test';

import { Brain, DEFAULT_BRAIN } from '../../src/lib/rover-brain/brain';
import { RoverSim, type SimFrame, type SimOptions, type SimWorld } from '../../src/lib/rover-brain/sim';

const pile = { center: [0, 0, 1] as [number, number, number], radiusM: 1 };

const OPEN: SimWorld = { leaves: [[0.5, -2], [-1, -1.5], [1.5, -2.5], [-0.3, -3], [2, -1], [-2, -2.5]], pile };

/** Leaves behind a trunk, between them and the pile. */
const TREE: SimWorld = {
  leaves: [[0, -3], [0.3, -3.4], [-0.4, -3.2]],
  obstacles: [{ center: [0, -1.6], radiusM: 0.25, heightM: 1 }],
  pile,
};

const YARD: SimWorld = {
  leaves: [[0, -3], [1.2, -2.6], [-1.5, -3.5], [2.5, -0.5], [-2.2, 0.5], [0.8, -4.2], [-0.6, -1.4], [1.9, -3.8]],
  obstacles: [
    { center: [0, -1.9], radiusM: 0.25, heightM: 1 },
    { center: [1.6, -1.5], radiusM: 0.3, heightM: 0.4 },
    { center: [-1.6, -2.4], radiusM: 0.2, heightM: 1 },
  ],
  pile,
};

const cleared = (f: SimFrame) => f.stats.onGround === 0 && f.stats.inScoop === 0;

function run(world: SimWorld, options: Partial<SimOptions> = {}, maxMs = 20 * 60_000) {
  const sim = new RoverSim(structuredClone(world), options);
  sim.start();
  return sim.run(cleared, maxMs);
}

describe('simulated rover', () => {
  test('clears an open patch into the pile', () => {
    for (const seed of [1, 2, 3]) {
      const f = run(OPEN, { seed });
      expect(f.stats).toMatchObject({ onGround: 0, inScoop: 0, inPile: 6, collisions: 0 });
      expect(f.timeMs).toBeLessThan(6 * 60_000);
    }
  });

  test('goes round a trunk to the leaves behind it, and back round it to the pile', () => {
    for (const seed of [1, 2, 3]) {
      const f = run(TREE, { seed });
      expect(f.stats).toMatchObject({ onGround: 0, inPile: 3, collisions: 0 });
    }
  });

  test('clears a cluttered yard without hitting anything', () => {
    for (const seed of [1, 2]) {
      const f = run(YARD, { seed });
      expect(f.stats).toMatchObject({ onGround: 0, inPile: 8, collisions: 0 });
    }
  });

  test('copes with false detections, noisy positions and a scoop that often misses', () => {
    const f = run(OPEN, { seed: 1, falsePerFrame: 0.3, noisePerM: 0.04, scoopSuccess: 0.7 });
    expect(f.stats).toMatchObject({ onGround: 0, inPile: 6, collisions: 0 });
  });

  test('leaves the pile alone', () => {
    // Every leaf is already in the pile: nothing to scoop.
    const sim = new RoverSim({ leaves: [[0.2, 0.6], [-0.3, 1.3], [0.5, 1.5]], pile, start: { position: [0, -0.5], yawDeg: 180 } });
    sim.start();
    let scooped = false;
    sim.run((f) => {
      scooped ||= f.scoop === 'down';
      return false;
    }, 60_000);
    expect(scooped).toBe(false);
    expect(sim.frame().stats.inPile).toBe(3);
  });

  test('gives up on a leaf that never comes up, after maxAttempts', () => {
    const sim = new RoverSim({ leaves: [[0, -1.5]], pile }, { scoopSuccess: 0 });
    sim.start();
    const f = sim.run((fr) => fr.tracked.some((l) => l.state === 'failed'), 10 * 60_000);
    const failed = f.tracked.find((l) => l.state === 'failed')!;
    expect(failed.attempts).toBe(DEFAULT_BRAIN.leafMap.maxAttempts);
    expect(f.stats.onGround).toBe(1);
  });

  test('carries several scoops per trip with a bigger capacity', () => {
    const brain = new Brain({ autopilot: { ...DEFAULT_BRAIN.autopilot, capacity: 3 } });
    const sim = new RoverSim(structuredClone(OPEN), { seed: 1 }, brain);
    sim.start();
    let mostCarried = 0;
    const f = sim.run((fr) => {
      mostCarried = Math.max(mostCarried, fr.stats.inScoop);
      return cleared(fr);
    }, 20 * 60_000);
    expect(f.stats).toMatchObject({ onGround: 0, inPile: 6, collisions: 0 });
    expect(mostCarried).toBeGreaterThan(1);
  });

  test('is deterministic for a seed', () => {
    const a = run(OPEN, { seed: 7 }, 60_000);
    const b = run(OPEN, { seed: 7 }, 60_000);
    expect(a.rover.position).toEqual(b.rover.position);
    expect(a.stats).toEqual(b.stats);
  });
});
