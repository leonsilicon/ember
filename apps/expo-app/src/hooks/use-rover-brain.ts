import { useCallback, useEffect, useRef, useState } from 'react';

import SplatCapture from '../../modules/splat-capture';

import type { DetectionResult } from '@/hooks/use-detections';
import { drive, stop, useRover } from '@/lib/rover';
import {
  corridors as corridorsFrom,
  DEFAULT_ROVER,
  headingFromPose,
  initialAutopilotState,
  isPose,
  LeafMap,
  locateDetections,
  ObstacleMemory,
  scanDepth,
  stepAutopilot,
  toRover,
  type AutopilotState,
  type Corridor,
  type Heading,
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
  /** Tracked leaves, nearest first, without collected ones. */
  leaves: BrainLeaf[];
  collected: number;
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
 * to leaves over Bluetooth. Pure logic lives in src/lib/rover-brain.
 */
export function useRoverBrain(result: DetectionResult | undefined, enabled: boolean): RoverBrain {
  const rover = useRover();
  const connected = rover.connection.state === 'connected';
  const map = useRef(new LeafMap());
  // Recent LiDAR points, so obstacles stay known after they leave the camera's narrow view.
  const memory = useRef(new ObstacleMemory());
  const heading = useRef<Heading | null>(null);
  // Reset with the real time whenever the autopilot starts.
  const autopilotState = useRef<AutopilotState>(initialAutopilotState(0));
  const [autopilotOn, setAutopilotOn] = useState(false);
  /** What the steering loop obeys; a ref so toggling the autopilot doesn't restart the loop. */
  const autopilotOnRef = useRef(false);
  const [view, setView] = useState<Omit<RoverBrain, 'startAutopilot' | 'stopAutopilot' | 'reset' | 'autopilot'> & { message: string }>({
    leaves: [],
    collected: 0,
    captions: [],
    corridors: [],
    hasDepth: false,
    tracking: false,
    message: '',
  });

  const publish = useCallback((patch: Partial<typeof view>) => {
    const h = heading.current;
    const all = map.current.snapshot();
    const leaves = h
      ? all
          .filter((l) => l.state !== 'collected')
          .map((l) => ({ ...l, rover: toRover(l.world, h) }))
          .sort((a, b) => a.rover.distance - b.rover.distance)
      : [];
    setView((previous) => ({
      ...previous,
      ...patch,
      leaves,
      collected: all.filter((l) => l.state === 'collected').length,
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
    const floorY = memory.current.floorY ?? (headingFromPose(camera.pose)?.origin[1] ?? 0) - DEFAULT_ROVER.cameraHeightM;
    // LiDAR checks each box (on the ground? leaf-sized?) before it reaches the leaf map.
    const { leaves: located, rejected } = locateDetections(result.detections, result.frameSize, camera, floorY);
    map.current.observe(located, Date.now());
    const captions: (string | undefined)[] = result.detections.map(() => undefined);
    for (const leaf of located) {
      if (leaf.source === 'floor') captions[leaf.index] = `~${caption(leaf.rover)}`;
    }
    for (const r of rejected) captions[r.index] = rejectionCaption(r);
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
          if (fresh) memory.current.add(fresh, now);
          const lanes = heading.current ? corridorsFrom(memory.current.scan(now), heading.current) : [];
          const scanAgeMs = memory.current.ageMs(now);

          let message = '';
          if (autopilotOnRef.current) {
            const step = stepAutopilot(autopilotState.current, {
              nowMs: Date.now(),
              heading: heading.current,
              leaves: map.current.snapshot(),
              corridors: lanes,
              scanAgeMs,
            });
            autopilotState.current = step.state;
            if (step.collectedId != null) map.current.markCollected(step.collectedId);
            drive(step.left, step.right);
            message = step.message;
          }
          publish({ corridors: lanes, hasDepth: fresh != null, tracking, message });
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
    setAutopilotOn(false);
    stop();
    publish({ message: '' });
  }, [publish]);

  const startAutopilot = useCallback(() => {
    autopilotState.current = initialAutopilotState(Date.now());
    setAutopilotOn(true);
  }, []);

  const reset = useCallback(() => {
    map.current.clear();
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
    reset,
  };
}
