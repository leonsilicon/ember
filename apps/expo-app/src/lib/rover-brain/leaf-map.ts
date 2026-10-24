/**
 * Leaves pinned to fixed points in the AR world.
 *
 * Detections flicker frame to frame, and a leaf drops out of view as the rover gets close (it ends
 * up below the camera). So each detection is placed in the world, merged with earlier sightings
 * of the same leaf, and the rover drives to that fixed point using its pose, not to a box in the
 * latest frame. A leaf is `confirmed` once it has been seen a few times, which filters one-off
 * false detections; unconfirmed ones are forgotten if they aren't seen again soon.
 *
 * A scooped leaf is `collected`, but the scoop can miss. The rover can't see under itself, so a
 * miss shows up later: the same leaf seen again on the ground once the rover has moved on. That
 * puts it back to `confirmed` for another try, or `failed` after `maxAttempts`, so the rover
 * doesn't push at a stuck leaf forever.
 */

import { sub } from './geometry';
import type { Vec3 } from './geometry';

export type LeafObservation = {
  world: Vec3;
  label: string;
  score: number;
  /** `lidar`: depth at the box centre. `floor`: the box centre's ray onto the floor. */
  source: 'lidar' | 'floor';
};

export type LeafState = 'tentative' | 'confirmed' | 'collected' | 'failed';

export type TrackedLeaf = {
  id: number;
  world: Vec3;
  label: string;
  /** Best detection score seen. */
  score: number;
  hits: number;
  state: LeafState;
  source: 'lidar' | 'floor';
  firstSeenMs: number;
  lastSeenMs: number;
  /** Times the rover has scooped at it. */
  attempts: number;
  /** When it was last marked collected. */
  collectedAtMs?: number;
  /** Sightings since then, which mean the scoop missed it. */
  missHits: number;
};

export type LeafMapOptions = {
  /** Sightings closer than this (horizontally) are the same leaf. */
  mergeRadiusM: number;
  /** Sightings before a leaf is trusted. */
  confirmHits: number;
  /** Unconfirmed leaves not seen again within this are dropped. */
  forgetTentativeMs: number;
  maxLeaves: number;
  /** Sightings of a collected leaf this soon after don't count as a miss (the frame was older). */
  missGraceMs: number;
  /** Scoops at one leaf before giving up on it. */
  maxAttempts: number;
};

export const DEFAULT_LEAF_MAP: LeafMapOptions = {
  mergeRadiusM: 0.25,
  confirmHits: 3,
  forgetTentativeMs: 4000,
  maxLeaves: 300,
  missGraceMs: 2000,
  maxAttempts: 3,
};

const horizontalDistance = (a: Vec3, b: Vec3) => {
  const d = sub(a, b);
  return Math.hypot(d[0], d[2]);
};

export class LeafMap {
  private leaves: TrackedLeaf[] = [];
  private nextId = 1;

  constructor(private readonly options: LeafMapOptions = DEFAULT_LEAF_MAP) {}

  /** Adds one frame's sightings. Returns the ids they were matched to, in order. */
  observe(observations: readonly LeafObservation[], nowMs: number): number[] {
    const ids = observations.map((obs) => {
      const match = this.nearest(obs.world);
      if (match) {
        // Running average, capped so a long-tracked leaf can still settle onto better (closer,
        // LiDAR) sightings. Floor-ray guesses never move a LiDAR-placed leaf.
        if (!(match.source === 'lidar' && obs.source === 'floor')) {
          const weight = Math.min(match.hits, 8);
          match.world = match.world.map((v, i) => (v * weight + obs.world[i]) / (weight + 1)) as Vec3;
          if (obs.source === 'lidar') match.source = 'lidar';
        }
        match.hits += 1;
        match.score = Math.max(match.score, obs.score);
        match.lastSeenMs = nowMs;
        if (match.state === 'tentative' && match.hits >= this.options.confirmHits) match.state = 'confirmed';
        if (match.state === 'collected' && nowMs - (match.collectedAtMs ?? 0) > this.options.missGraceMs) {
          match.missHits += 1;
          if (match.missHits >= this.options.confirmHits) {
            match.state = match.attempts >= this.options.maxAttempts ? 'failed' : 'confirmed';
          }
        }
        return match.id;
      }
      const leaf: TrackedLeaf = {
        id: this.nextId++,
        world: [...obs.world] as Vec3,
        label: obs.label,
        score: obs.score,
        hits: 1,
        state: this.options.confirmHits <= 1 ? 'confirmed' : 'tentative',
        source: obs.source,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        attempts: 0,
        missHits: 0,
      };
      this.leaves.push(leaf);
      return leaf.id;
    });
    this.prune(nowMs);
    return ids;
  }

  /** Marks a leaf scooped up, so the rover doesn't go back for it unless it's seen again. */
  markCollected(id: number, nowMs: number) {
    const leaf = this.leaves.find((l) => l.id === id);
    if (!leaf) return;
    leaf.state = 'collected';
    leaf.attempts += 1;
    leaf.collectedAtMs = nowMs;
    leaf.missHits = 0;
  }

  /** Gives up on a leaf, e.g. one the rover can't get its scoop to. */
  markFailed(id: number) {
    const leaf = this.leaves.find((l) => l.id === id);
    if (leaf) leaf.state = 'failed';
  }

  get(id: number): TrackedLeaf | undefined {
    const leaf = this.leaves.find((l) => l.id === id);
    return leaf && { ...leaf, world: [...leaf.world] as Vec3 };
  }

  /** A copy of every tracked leaf, safe to keep in React state. */
  snapshot(): TrackedLeaf[] {
    return this.leaves.map((l) => ({ ...l, world: [...l.world] as Vec3 }));
  }

  clear() {
    this.leaves = [];
  }

  private nearest(world: Vec3): TrackedLeaf | undefined {
    let best: TrackedLeaf | undefined;
    let bestDistance = this.options.mergeRadiusM;
    for (const leaf of this.leaves) {
      const d = horizontalDistance(leaf.world, world);
      if (d <= bestDistance) {
        best = leaf;
        bestDistance = d;
      }
    }
    return best;
  }

  private prune(nowMs: number) {
    this.leaves = this.leaves.filter(
      (l) => l.state !== 'tentative' || nowMs - l.lastSeenMs <= this.options.forgetTentativeMs,
    );
    if (this.leaves.length > this.options.maxLeaves) {
      // Drop the oldest unconfirmed ones first, then the oldest finished ones.
      const rank = (l: TrackedLeaf) => (l.state === 'tentative' ? 0 : l.state === 'confirmed' ? 2 : 1);
      this.leaves.sort((a, b) => rank(a) - rank(b) || a.lastSeenMs - b.lastSeenMs);
      this.leaves = this.leaves.slice(this.leaves.length - this.options.maxLeaves);
    }
  }
}
