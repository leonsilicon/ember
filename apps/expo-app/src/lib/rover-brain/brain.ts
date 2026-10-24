/**
 * The whole brain in one object, with no clock or sensors of its own: leaf sightings and depth
 * scans go in, wheel speeds and a scoop position come out of `tick`. The phone
 * (src/hooks/use-rover-brain.ts) feeds it from ARKit and the detector; the simulator (sim.ts)
 * feeds it from a virtual world. Both run exactly this code.
 */

import { DEFAULT_AUTOPILOT, initialAutopilotState, stepAutopilot } from './autopilot';
import type { AutopilotConfig, AutopilotState, AutopilotStep, Pile } from './autopilot';
import { toRover } from './geometry';
import type { Heading } from './geometry';
import { DEFAULT_LEAF_MAP, LeafMap } from './leaf-map';
import type { LeafMapOptions, LeafObservation } from './leaf-map';
import { corridors, DEFAULT_OBSTACLE_MEMORY, DEFAULT_ROVER, ObstacleMemory } from './obstacles';
import type { Corridor, DepthScan, ObstacleMemoryOptions, RoverSpec } from './obstacles';

export type BrainOptions = {
  autopilot: AutopilotConfig;
  leafMap: LeafMapOptions;
  obstacleMemory: ObstacleMemoryOptions;
  rover: RoverSpec;
  /**
   * With leaves in the scoop, sightings this close to the camera are ignored: the raised scoop
   * can be in view, and what's in it isn't on the ground.
   */
  selfMaskM: number;
};

export const DEFAULT_BRAIN: BrainOptions = {
  autopilot: DEFAULT_AUTOPILOT,
  leafMap: DEFAULT_LEAF_MAP,
  obstacleMemory: DEFAULT_OBSTACLE_MEMORY,
  rover: DEFAULT_ROVER,
  selfMaskM: 0.35,
};

export type BrainTick = {
  corridors: Corridor[];
  scanAgeMs: number;
  /** The autopilot's decision; absent while it's off. */
  step?: AutopilotStep;
};

export class Brain {
  readonly options: BrainOptions;
  readonly leaves: LeafMap;
  readonly obstacles: ObstacleMemory;
  pile: Pile | null = null;
  autopilot: AutopilotState = initialAutopilotState(0);
  running = false;
  /** Scoop loads tipped onto the pile so far. */
  dumped = 0;

  constructor(options: Partial<BrainOptions> = {}) {
    this.options = { ...DEFAULT_BRAIN, ...options };
    this.leaves = new LeafMap(this.options.leafMap);
    this.obstacles = new ObstacleMemory(this.options.obstacleMemory);
  }

  /** One frame's leaf sightings, with the rover's heading when the frame was taken. */
  observe(observations: readonly LeafObservation[], frameHeading: Heading | null, nowMs: number) {
    const carrying = this.autopilot.load > 0;
    const kept =
      carrying && frameHeading
        ? observations.filter((o) => toRover(o.world, frameHeading).distance >= this.options.selfMaskM)
        : observations;
    return this.leaves.observe(kept, nowMs);
  }

  addScan(scan: DepthScan, nowMs: number) {
    this.obstacles.add(scan, nowMs);
  }

  setPile(pile: Pile | null) {
    this.pile = pile;
  }

  /** Starts the autopilot. Whatever is in the scoop stays counted. */
  start(nowMs: number) {
    this.autopilot = initialAutopilotState(nowMs, this.autopilot.load);
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  /** Forgets every leaf (e.g. after moving the rover by hand). */
  reset() {
    this.leaves.clear();
  }

  /** Corridors from the current heading and, with the autopilot on, its next step. */
  tick(nowMs: number, heading: Heading | null): BrainTick {
    const lanes = heading ? corridors(this.obstacles.scan(nowMs), heading, this.options.rover) : [];
    const scanAgeMs = this.obstacles.ageMs(nowMs);
    if (!this.running) return { corridors: lanes, scanAgeMs };
    const step = stepAutopilot(
      this.autopilot,
      { nowMs, heading, leaves: this.leaves.snapshot(), corridors: lanes, scanAgeMs, pile: this.pile },
      this.options.autopilot,
    );
    this.autopilot = step.state;
    for (const id of step.collectedIds ?? []) this.leaves.markCollected(id, nowMs);
    if (step.missingId != null) this.leaves.markCollected(step.missingId, nowMs);
    if (step.failedId != null) this.leaves.markFailed(step.failedId);
    if (step.dumped) this.dumped += step.dumped;
    return { corridors: lanes, scanAgeMs, step };
  }
}
