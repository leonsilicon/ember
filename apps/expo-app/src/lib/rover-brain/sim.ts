/**
 * A simulated rover, to try the brain without hardware: in tests, or in a web app that draws the
 * world (later over a Gaussian splat of the real place).
 *
 * The world is flat ground at y = 0 (ARKit's gravity-aligned axes, metres) with leaves, obstacles
 * and a pile. Each tick the simulator does what the phone and rover would:
 *
 * - **camera**: every `detectEveryMs`, leaves in the camera's view are "detected", each with a
 *   chance that falls with distance and a position error that grows with it, and passed to the
 *   brain like the phone's located detections;
 * - **LiDAR**: obstacle surfaces (and any static scene points, e.g. a downsampled splat) inside
 *   the view become a depth scan;
 * - **rover**: the brain's wheel speeds drive a differential-drive body; the scoop picks up the
 *   ground leaves its lip passes over while it's down (each with `scoopSuccess` odds) and drops
 *   them in front when it tips.
 *
 * The brain only ever sees those sightings and scans, never the true leaf positions. Runs are
 * deterministic for a given `seed`.
 */

import { Brain } from './brain';
import type { BrainTick } from './brain';
import type { Pile, ScoopPosition } from './autopilot';
import { headingFromPose, makePose, toRover } from './geometry';
import type { Heading, Intrinsics, Pose, Vec3 } from './geometry';
import type { LeafObservation, TrackedLeaf } from './leaf-map';
import { inView, MAX_RANGE_M } from './obstacles';
import type { DepthScan } from './obstacles';

/** An upright cylinder: a tree trunk, a rock, a post. `center` is [x, z]. */
export type SimObstacle = { center: [number, number]; radiusM: number; heightM: number };

export type SimWorld = {
  /** Leaves on the ground, [x, z]. */
  leaves: [number, number][];
  obstacles?: SimObstacle[];
  /**
   * Static scene points in world metres with the floor at y = 0, seen by the simulated LiDAR
   * (e.g. a splat's centres, downsampled to a few cm). Not used for collisions.
   */
  points?: Vec3[];
  pile?: Pile;
  /** Where the rover starts, [x, z], facing `yawDeg` (0 = world −z, + clockwise from above). */
  start?: { position: [number, number]; yawDeg: number };
};

export type SimOptions = {
  tickMs: number;
  /** Physics steps per tick. */
  substeps: number;
  detectEveryMs: number;
  /** Wheel speed at 100 %, m/s. */
  topSpeedMps: number;
  trackWidthM: number;
  cameraHeightM: number;
  cameraPitchDeg: number;
  /** Camera image: portrait iPhone, about 54° wide and 69° tall. */
  intrinsics: Intrinsics;
  detectRangeM: number;
  /** Chance a leaf in view is detected in a frame, at 0 m and at detectRangeM. */
  detectNearP: number;
  detectFarP: number;
  /** Position error (standard deviation, metres) at 0 m, plus this much per metre. */
  noiseM: number;
  noisePerM: number;
  /** False detections per frame, somewhere in view. */
  falsePerFrame: number;
  /** Chance a leaf under the lip ends up in the scoop. */
  scoopSuccess: number;
  /** How deep the scoop is, behind its lip. */
  scoopDepthM: number;
  /** The wheel axle's centre (where it turns about) is this far behind the camera. */
  axleBackM: number;
  /** The rover's body, a circle round the axle's centre, for collisions. */
  bodyRadiusM: number;
  seed: number;
};

export const DEFAULT_SIM: SimOptions = {
  tickMs: 200,
  substeps: 4,
  detectEveryMs: 400,
  topSpeedMps: 0.6,
  trackWidthM: 0.3,
  cameraHeightM: 0.3,
  cameraPitchDeg: 20,
  intrinsics: { fx: 1400, fy: 1400, cx: 720, cy: 960, width: 1440, height: 1920 },
  detectRangeM: 5,
  detectNearP: 0.9,
  detectFarP: 0.3,
  noiseM: 0.01,
  noisePerM: 0.02,
  falsePerFrame: 0,
  scoopSuccess: 0.9,
  scoopDepthM: 0.2,
  axleBackM: 0.12,
  bodyRadiusM: 0.2,
  seed: 1,
};

export type SimLeaf = {
  id: number;
  position: Vec3;
  /** On the ground, in the scoop, or on the ground inside the pile's radius. */
  where: 'ground' | 'scoop' | 'pile';
};

export type SimFrame = {
  timeMs: number;
  /** Camera position and heading; `pose` is the camera-to-world matrix (column-major), as ARKit gives it. */
  rover: { position: Vec3; yawDeg: number; pose: Pose };
  scoop: ScoopPosition;
  /** The truth. */
  leaves: SimLeaf[];
  /** What the brain believes. */
  tracked: TrackedLeaf[];
  tick: BrainTick;
  pile: Pile | null;
  stats: { onGround: number; inScoop: number; inPile: number; collisions: number; dumped: number };
};

/** mulberry32: small, fast and seedable. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on a cylinder's side every 10° and 5 cm up, plus its top. */
function cylinderPoints(o: SimObstacle): Vec3[] {
  const points: Vec3[] = [];
  const top = Math.min(o.heightM, 0.6);
  for (let a = 0; a < 360; a += 10) {
    const x = o.center[0] + o.radiusM * Math.sin((a * Math.PI) / 180);
    const z = o.center[1] + o.radiusM * Math.cos((a * Math.PI) / 180);
    for (let y = 0.02; y <= top; y += 0.05) points.push([x, y, z]);
    for (let f = 0.25; f < 1; f += 0.25) {
      points.push([o.center[0] + (x - o.center[0]) * f, top, o.center[1] + (z - o.center[1]) * f]);
    }
  }
  return points;
}

export class RoverSim {
  readonly brain: Brain;
  readonly options: SimOptions;
  readonly world: SimWorld;
  timeMs = 0;
  leaves: SimLeaf[];
  /** Camera position on the ground plane and heading. */
  x: number;
  z: number;
  yawDeg: number;
  scoop: ScoopPosition = 'up';
  collisions = 0;
  private rand: () => number;
  private wheels = { left: 0, right: 0 };
  private lastDetectMs = -Infinity;
  private colliding = false;
  private obstaclePoints: Vec3[];
  /** Leaves already given their one chance at the scoop on this pass. */
  private tried = new Set<number>();
  private lastTick: BrainTick = { corridors: [], scanAgeMs: Infinity };

  constructor(world: SimWorld, options: Partial<SimOptions> = {}, brain = new Brain()) {
    this.world = world;
    this.options = { ...DEFAULT_SIM, ...options };
    this.brain = brain;
    this.rand = random(this.options.seed);
    this.leaves = world.leaves.map(([x, z], i) => ({ id: i + 1, position: [x, 0, z], where: 'ground' }));
    // `start` is where the camera starts.
    this.x = world.start?.position[0] ?? 0;
    this.z = world.start?.position[1] ?? 0;
    this.yawDeg = world.start?.yawDeg ?? 0;
    this.obstaclePoints = [...(world.obstacles ?? []).flatMap(cylinderPoints), ...(world.points ?? [])];
    if (world.pile) brain.setPile(world.pile);
    this.classify();
  }

  get pose(): Pose {
    return makePose([this.x, this.options.cameraHeightM, this.z], this.options.cameraPitchDeg, this.yawDeg);
  }

  get heading(): Heading {
    return headingFromPose(this.pose)!;
  }

  /** Starts the brain's autopilot. */
  start() {
    this.brain.start(this.timeMs);
  }

  /** Puts the pile somewhere (or removes it), for the brain and for scoring. */
  setPile(pile: Pile | null) {
    this.world.pile = pile ?? undefined;
    this.brain.setPile(pile);
    this.classify();
  }

  /** Advances one tick: sense, think, act. */
  step(): SimFrame {
    const o = this.options;
    const pose = this.pose;
    const view = { pose, intrinsics: o.intrinsics };
    const heading = this.heading;

    if (this.timeMs - this.lastDetectMs >= o.detectEveryMs) {
      this.lastDetectMs = this.timeMs;
      this.brain.observe(this.detect(view, heading), heading, this.timeMs);
    }
    this.brain.addScan(this.scan(view), this.timeMs);
    const tick = this.brain.tick(this.timeMs, heading);
    this.lastTick = tick;
    const step = tick.step;
    this.wheels = step ? { left: step.left, right: step.right } : { left: 0, right: 0 };
    this.setScoop(step?.scoop ?? this.scoop);

    const dt = o.tickMs / 1000 / o.substeps;
    for (let i = 0; i < o.substeps; i++) {
      this.move(dt);
      if (this.scoop === 'down') this.pickUp();
    }
    this.timeMs += o.tickMs;
    this.classify();
    return this.frame();
  }

  /** Steps until `done` or `maxMs` of simulated time; returns the last frame. */
  run(done: (frame: SimFrame) => boolean, maxMs: number): SimFrame {
    let frame = this.frame();
    const end = this.timeMs + maxMs;
    while (this.timeMs < end && !done(frame)) frame = this.step();
    return frame;
  }

  frame(): SimFrame {
    const count = (where: SimLeaf['where']) => this.leaves.filter((l) => l.where === where).length;
    return {
      timeMs: this.timeMs,
      rover: { position: [this.x, this.options.cameraHeightM, this.z], yawDeg: this.yawDeg, pose: this.pose },
      scoop: this.scoop,
      leaves: this.leaves.map((l) => ({ ...l, position: [...l.position] as Vec3 })),
      tracked: this.brain.leaves.snapshot(),
      tick: this.lastTick,
      pile: this.brain.pile,
      stats: {
        onGround: count('ground'),
        inScoop: count('scoop'),
        inPile: count('pile'),
        collisions: this.collisions,
        dumped: this.brain.dumped,
      },
    };
  }

  private gaussian() {
    const u = Math.max(this.rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  private detect(view: { pose: Pose; intrinsics: Intrinsics }, heading: Heading): LeafObservation[] {
    const o = this.options;
    const seen: LeafObservation[] = [];
    const sighting = (truth: Vec3, distance: number) => {
      const sd = o.noiseM + o.noisePerM * distance;
      seen.push({
        world: [truth[0] + this.gaussian() * sd, 0, truth[2] + this.gaussian() * sd],
        label: 'dry leaf',
        score: 0.3,
        source: distance <= MAX_RANGE_M - 1 ? 'lidar' : 'floor',
      });
    };
    for (const leaf of this.leaves) {
      if (leaf.where === 'scoop' || !inView(leaf.position, view, o.detectRangeM)) continue;
      const d = toRover(leaf.position, heading).distance;
      const p = o.detectNearP + (o.detectFarP - o.detectNearP) * Math.min(1, d / o.detectRangeM);
      if (this.rand() < p) sighting(leaf.position, d);
    }
    // False detections: random ground points, kept only if in view. A fractional rate is a chance.
    const falses = Math.floor(o.falsePerFrame) + (this.rand() < o.falsePerFrame % 1 ? 1 : 0);
    for (let i = 0; i < falses; i++) {
      const forward = 0.5 + this.rand() * (o.detectRangeM - 0.5);
      const right = (this.rand() - 0.5) * forward;
      const p: Vec3 = [
        heading.origin[0] + heading.forward[0] * forward + heading.right[0] * right,
        0,
        heading.origin[2] + heading.forward[2] * forward + heading.right[2] * right,
      ];
      if (inView(p, view, o.detectRangeM)) sighting(p, forward);
    }
    return seen;
  }

  /** What the LiDAR would see: obstacle surfaces and the pile's mound, inside the view. */
  private scan(view: { pose: Pose; intrinsics: Intrinsics }): DepthScan {
    const points = [...this.obstaclePoints, ...this.moundPoints()].filter((p) => inView(p, view));
    return { points, floorY: 0, floorSource: 'lidar', timestamp: this.timeMs / 1000, view };
  }

  /** The leaves piled up: a low mound that grows with them and blocks the LiDAR once it's tall. */
  private moundPoints(): Vec3[] {
    const piled = this.leaves.filter((l) => l.where === 'pile');
    if (!piled.length || !this.world.pile) return [];
    const c = this.world.pile.center;
    const heightM = Math.min(0.35, 0.006 * piled.length);
    const radiusM = Math.min(this.world.pile.radiusM * 0.5, 0.1 + 0.015 * piled.length);
    return cylinderPoints({ center: [c[0], c[2]], radiusM, heightM });
  }

  private move(dt: number) {
    const o = this.options;
    const left = (this.wheels.left / 100) * o.topSpeedMps;
    const right = (this.wheels.right / 100) * o.topSpeedMps;
    const v = (left + right) / 2;
    // Left faster than right turns right, which is + yaw (clockwise from above). The rover turns
    // about its axle, so the camera in front of it swings round.
    const omegaDeg = (((left - right) / o.trackWidthM) * 180) / Math.PI;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    let ax = this.x - Math.sin(rad(this.yawDeg)) * o.axleBackM;
    let az = this.z + Math.cos(rad(this.yawDeg)) * o.axleBackM;
    const mid = rad(this.yawDeg + (omegaDeg * dt) / 2);
    ax += Math.sin(mid) * v * dt;
    az -= Math.cos(mid) * v * dt;
    this.yawDeg += omegaDeg * dt;
    this.x = ax + Math.sin(rad(this.yawDeg)) * o.axleBackM;
    this.z = az - Math.cos(rad(this.yawDeg)) * o.axleBackM;

    // Carried leaves ride in the scoop.
    const h = this.heading;
    for (const leaf of this.leaves) {
      if (leaf.where !== 'scoop') continue;
      leaf.position = [h.origin[0] + h.forward[0] * 0.08, 0.1, h.origin[2] + h.forward[2] * 0.08];
    }

    // Count each time the body runs into an obstacle (the pile's mound doesn't count: it's soft).
    const bx = this.x - h.forward[0] * o.axleBackM;
    const bz = this.z - h.forward[2] * o.axleBackM;
    const hit = (this.world.obstacles ?? []).some(
      (ob) => Math.hypot(bx - ob.center[0], bz - ob.center[1]) < o.bodyRadiusM + ob.radiusM,
    );
    if (hit && !this.colliding) this.collisions += 1;
    this.colliding = hit;
  }

  private pickUp() {
    const o = this.options;
    const lip = this.brain.options.autopilot.scoopLipM;
    const width = this.brain.options.autopilot.scoopWidthM;
    const h = this.heading;
    for (const leaf of this.leaves) {
      if (leaf.where === 'scoop' || this.tried.has(leaf.id)) continue;
      const r = toRover(leaf.position, h);
      if (Math.abs(r.right) > width / 2 || r.forward > lip || r.forward < lip - o.scoopDepthM) continue;
      this.tried.add(leaf.id);
      if (this.rand() < o.scoopSuccess) leaf.where = 'scoop';
    }
  }

  private setScoop(position: ScoopPosition) {
    if (position === this.scoop) return;
    if (position === 'down') this.tried.clear();
    if (position === 'dump') {
      // Tipped out in front of the lip, scattering a little.
      const h = this.heading;
      const lip = this.brain.options.autopilot.scoopLipM + 0.05;
      for (const leaf of this.leaves) {
        if (leaf.where !== 'scoop') continue;
        leaf.position = [
          h.origin[0] + h.forward[0] * lip + this.gaussian() * 0.06,
          0,
          h.origin[2] + h.forward[2] * lip + this.gaussian() * 0.06,
        ];
        leaf.where = 'ground';
      }
    }
    this.scoop = position;
  }

  private classify() {
    const pile = this.world.pile;
    for (const leaf of this.leaves) {
      if (leaf.where === 'scoop') continue;
      const inside = pile != null && Math.hypot(leaf.position[0] - pile.center[0], leaf.position[2] - pile.center[2]) <= pile.radiusM;
      leaf.where = inside ? 'pile' : 'ground';
    }
  }
}
