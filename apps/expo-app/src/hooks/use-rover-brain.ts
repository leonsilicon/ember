import { useCallback, useEffect, useRef, useState } from 'react';

import SplatCapture from '../../modules/splat-capture';

import type { DetectionResult } from '@/hooks/use-detections';
import { drive, stop, useRover } from '@/lib/rover';
import {
  Brain,
  DEFAULT_PILE_RADIUS_M,
  DEFAULT_ROVER,
  headingFromPose,
  inPile,
  inWorkArea,
  isPose,
  locateDetections,
  scanDepth,
  toRover,
  type Corridor,
  type Heading,
  type Pile,
  type RejectedDetection,
  type RoverPoint,
  type TrackedLeaf,
} from '@/lib/rover-brain';

/** How often the steering loop reads the camera pose and LiDAR depth. */
const TICK_MS = 200;

export type BrainLeaf = TrackedLeaf & {
  /** Where it is from the rover now (it moves as the rover does). */
  rover: RoverPoint;
};

export type RoverBrain = {
  /** Tracked leaves in the work circle, nearest first, without collected, failed or piled ones. */
  leaves: BrainLeaf[];
  collected: number;
  /** Where the leaves go, and where it is from the rover now. */
  pile: (Pile & { rover?: RoverPoint }) | null;
  /** Scoops in the bin, how many it holds before a trip to the pile, and scoops emptied so far. */
  load: number;
  capacity: number;
  dumped: number;
  /**
   * Per detection of `captionsFor`: why LiDAR ruled it out, "~1.2 m · 15° R" for a leaf placed
   * without LiDAR (on the floor plane), or undefined. A LiDAR-placed leaf's box already shows its
   * LiDAR distance (`DetectionResult.distances`).
   */
  captions: (string | undefined)[];
  /** The detection result `captions` belong to; show them only with that result. */
  captionsFor?: DetectionResult;
  corridors: Corridor[];
  /** The phone has LiDAR depth right now. */
  hasDepth: boolean;
  tracking: boolean;
  autopilot: { on: boolean; message: string };
  startAutopilot: () => void;
  stopAutopilot: () => void;
  /** Puts the pile where the rover is standing, so it starts from the pile and works the circle round it. */
  setPileHere: () => void;
  /** The circle round the pile it collects leaves in. */
  workRadiusM: number;
  /** Forget every leaf (e.g. after moving the rover by hand). */
  reset: () => void;
};

export function caption(point: RoverPoint) {
  const b = Math.round(point.bearingDeg);
  const direction = Math.abs(b) < 3 ? 'ahead' : `${Math.abs(b)}° ${b > 0 ? 'R' : 'L'}`;
  return `${point.distance.toFixed(1)} m · ${direction}`;
}

/** Why LiDAR ruled a detection out, for its box. */
function rejectionCaption(r: RejectedDetection): string | undefined {
  switch (r.reason) {
    case 'off_ground':
      return `✕ ${(r.heightAboveFloorM ?? 0).toFixed(1)} m off the ground`;
    case 'too_big':
      return `✕ too big (${(r.sizeM ?? 0).toFixed(1)} m)`;
    case 'too_small':
      return '✕ too small';
    case 'too_far':
      return `✕ too far (${(r.rover?.distance ?? 0).toFixed(0)} m)`;
    default:
      return undefined;
  }
}

/**
 * The rover's brain on the phone: places each leaf detection in the AR world, keeps a map of
 * them, scans LiDAR depth for where it can't drive, and, with the autopilot on, drives the rover
 * over Bluetooth to scoop leaves up and take them to the pile. Pure logic lives in
 * src/lib/rover-brain (`Brain`, which the simulator runs too).
 */
export function useRoverBrain(result: DetectionResult | undefined, enabled: boolean): RoverBrain {
  const rover = useRover();
  const connected = rover.connection.state === 'connected';
  // Leaf map, recent LiDAR points (so obstacles stay known after they leave the camera's narrow
  // view), pile and autopilot.
  const brain = useRef(new Brain());
  const heading = useRef<Heading | null>(null);
  const [autopilotOn, setAutopilotOn] = useState(false);
  /** What the steering loop obeys; a ref so toggling the autopilot doesn't restart the loop. */
  const autopilotOnRef = useRef(false);
  const [view, setView] = useState<
    Omit<RoverBrain, 'startAutopilot' | 'stopAutopilot' | 'setPileHere' | 'reset' | 'autopilot' | 'workRadiusM'> & { message: string }
  >({
    leaves: [],
    collected: 0,
    pile: null,
    load: 0,
    capacity: 0,
    dumped: 0,
    captions: [],
    corridors: [],
    hasDepth: false,
    tracking: false,
    message: '',
  });

  const publish = useCallback((patch: Partial<typeof view>) => {
    const h = heading.current;
    const current = brain.current;
    const all = current.leaves.snapshot();
    const leaves = h
      ? all
          .filter(
            (l) =>
              (l.state === 'confirmed' || l.state === 'tentative') &&
              !inPile(l.world, current.pile) &&
              inWorkArea(l.world, current.pile, current.options.autopilot),
          )
          .map((l) => ({ ...l, rover: toRover(l.world, h) }))
          .sort((a, b) => a.rover.distance - b.rover.distance)
      : [];
    setView((previous) => ({
      ...previous,
      ...patch,
      leaves,
      collected: all.filter((l) => l.state === 'collected').length,
      pile: current.pile && { ...current.pile, rover: h ? toRover(current.pile.center, h) : undefined },
      load: current.autopilot.load,
      capacity: current.options.autopilot.capacity,
      dumped: current.dumped,
    }));
  }, []);

  // Each detection result: place its boxes in the world and add them to the leaf map.
  useEffect(() => {
    const camera = result?.camera;
    if (!enabled || !result || !camera || !isPose(camera.pose)) return;
    if (!camera.trackingNormal) {
      publish({ captions: [], captionsFor: result });
      return;
    }
    const frameHeading = headingFromPose(camera.pose);
    const floorY = brain.current.obstacles.floorY ?? (frameHeading?.origin[1] ?? 0) - DEFAULT_ROVER.cameraHeightM;
    // A coasting box is where the detector last saw the leaf, which may not be where this frame's
    // camera and depth would put it, so only this frame's sightings are placed in the world.
    const seen = result.detections.map((d, index) => ({ d, index })).filter(({ d }) => !d.coasting);
    // LiDAR checks each box (on the ground? leaf-sized?) before it reaches the leaf map.
    const { leaves: located, rejected } = locateDetections(seen.map(({ d }) => d), result.frameSize, camera, floorY);
    brain.current.observe(located, frameHeading, Date.now());
    const captions: (string | undefined)[] = result.detections.map(() => undefined);
    for (const leaf of located) {
      if (leaf.source === 'floor') captions[seen[leaf.index].index] = `~${caption(leaf.rover)}`;
    }
    for (const r of rejected) captions[seen[r.index].index] = rejectionCaption(r);
    publish({ captions, captionsFor: result });
  }, [enabled, result, publish]);

  // The steering loop: pose + depth a few times a second, corridors, and the autopilot.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const started = Date.now();
        try {
          const camera = await SplatCapture.currentCamera(true);
          if (cancelled) break;
          const tracking = camera != null && camera.trackingNormal && isPose(camera.pose);
          heading.current = tracking && camera ? headingFromPose(camera.pose) : null;
          const now = Date.now();
          const fresh = camera ? scanDepth(camera) : null;
          if (fresh) brain.current.addScan(fresh, now);
          // The brain's autopilot follows the switch; starting it afresh each time it's turned on.
          if (autopilotOnRef.current !== brain.current.running) {
            if (autopilotOnRef.current) brain.current.start(now);
            else brain.current.stop();
          }
          const tick = brain.current.tick(now, heading.current);
          // The firmware has no scoop yet; tick.step.scoop ('up' | 'down' | 'dump') is what it would get.
          if (tick.step) drive(tick.step.left, tick.step.right);
          publish({
            corridors: tick.corridors,
            hasDepth: fresh != null,
            tracking,
            message: tick.step?.message ?? '',
          });
        } catch {
          // The camera isn't running yet (or was paused); the autopilot must not keep driving.
          if (autopilotOnRef.current) stop();
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, TICK_MS - (Date.now() - started))));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, publish]);

  // The autopilot only runs while the brain is enabled and the rover connected. Whenever it stops
  // for any reason, stop the motors explicitly: rover.ts keeps resending the last non-zero command.
  useEffect(() => {
    const active = autopilotOn && enabled && connected;
    if (autopilotOnRef.current && !active) stop();
    autopilotOnRef.current = active;
    // Switch it off for good, so it doesn't resume by itself when the rover reconnects or the
    // screen comes back; driving again takes a tap on Auto.
    if (autopilotOn && !active) {
      const timer = setTimeout(() => setAutopilotOn(false), 0);
      return () => clearTimeout(timer);
    }
  }, [autopilotOn, enabled, connected]);

  const stopAutopilot = useCallback(() => {
    autopilotOnRef.current = false;
    brain.current.stop();
    setAutopilotOn(false);
    stop();
    publish({ message: '' });
  }, [publish]);

  const startAutopilot = useCallback(() => setAutopilotOn(true), []);

  const setPileHere = useCallback(() => {
    const h = heading.current;
    if (!h) return;
    const floorY = brain.current.obstacles.floorY ?? h.origin[1] - DEFAULT_ROVER.cameraHeightM;
    brain.current.setPile({ center: [h.origin[0], floorY, h.origin[2]], radiusM: DEFAULT_PILE_RADIUS_M });
    publish({});
  }, [publish]);

  const reset = useCallback(() => {
    brain.current.reset();
    publish({ captions: [], captionsFor: undefined });
  }, [publish]);

  // Never leave the rover driving after the screen goes away.
  useEffect(
    () => () => {
      if (autopilotOnRef.current) {
        autopilotOnRef.current = false;
        stop();
      }
    },
    [],
  );

  const { message, ...rest } = view;
  return {
    ...rest,
    autopilot: { on: autopilotOn && enabled && connected, message },
    startAutopilot,
    stopAutopilot,
    setPileHere,
    workRadiusM: brain.current.options.autopilot.workRadiusM,
    reset,
  };
}
