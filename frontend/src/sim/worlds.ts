import { DEFAULT_PILE_RADIUS_M, FOOT_M } from '@rover-brain'
import type { Pile, SimOptions, SimWorld } from '@rover-brain'

/** Every yard's pile: at the origin, where the rover starts. */
export const PILE: Pile = { center: [0, 0, 0], radiusM: DEFAULT_PILE_RADIUS_M }

/**
 * Yard presets. Leaves are [x, z] in metres on flat ground; the rover starts on the pile at the origin,
 * facing −z. Each yard has leaves inside the default 6 ft (1.83 m) circle round the pile and a few
 * outside it, so you can see the rover leave those alone (or widen the circle to fetch them).
 */
export const WORLDS: Record<string, SimWorld> = {
  Backyard: {
    leaves: [
      [0.8, -0.5], [-0.9, -1.0], [0.2, 1.3], [-0.4, 0.9], [1.5, 0.4], [0.1, -1.6], [-1.2, -0.2],
      [2.6, -1.6], [-2.9, 1.8], [0.6, -3.1], [3.0, 1.5], [-2.0, -3.2],
    ],
    obstacles: [
      { center: [1.3, -1.2], radiusM: 0.25, heightM: 1 },
      { center: [-1.6, 0.9], radiusM: 0.3, heightM: 0.4 },
      { center: [-2.4, -2.2], radiusM: 0.2, heightM: 1 },
    ],
    pile: PILE,
  },
  'Behind a tree': {
    leaves: [[0.1, -1.6], [-0.3, -1.7], [0.35, -1.45], [1.2, 0.6], [-1.1, 0.5], [2.4, -2.4], [-2.6, -1.9]],
    obstacles: [{ center: [0, -1.0], radiusM: 0.25, heightM: 1 }],
    pile: PILE,
  },
  'Open lawn': {
    leaves: [
      [0.9, -0.9], [-1.3, -0.4], [0.3, -1.7], [1.6, 0.5], [-0.7, 1.4], [-1.5, -1.1], [1.0, 1.2],
      [2.8, -0.6], [-3.1, -1.4], [1.9, 2.7],
    ],
    pile: PILE,
  },
  'Leafy lawn': {
    leaves: [
      [0.7, -0.6], [-0.8, -0.7], [0.1, -1.3], [1.3, -0.1], [-1.4, 0.3], [0.5, 1.1], [-0.6, 1.2], [1.1, 0.9],
      [-1.2, -1.2], [0.9, -1.5], [-0.2, 1.7], [1.7, -0.6], [2.3, -1.9], [-2.6, 0.4], [0.4, -2.8], [2.6, 1.6],
      [-1.9, 2.4], [-2.8, -2.3], [3.1, -0.3], [-0.9, -3.0],
    ],
    obstacles: [
      { center: [-1.9, -1.6], radiusM: 0.22, heightM: 1 },
      { center: [2.0, 0.9], radiusM: 0.25, heightM: 1 },
      { center: [0.0, -2.2], radiusM: 0.25, heightM: 0.35 },
    ],
    pile: PILE,
  },
}

export const DEFAULT_WORLD = 'Backyard'

/** False sightings, noisier positions and a scoop that misses 30% of the time. */
export const HARSH_SENSORS: Partial<SimOptions> = { falsePerFrame: 0.3, noisePerM: 0.04, scoopSuccess: 0.7 }

/** The area both views frame, in world metres (x right, z toward the viewer in 2D), centred on the pile. */
export const VIEW = { x0: -4, x1: 4, z0: -4, z1: 4 }

export const SPEEDS = [1, 4, 10, 30]
export const DEFAULT_SPEED = 4

/** The work circle's radius: settable in whole feet, as people pace it out. */
export const WORK_RADIUS_FT = { min: 2, max: 12, default: 6 }
export const ftToM = (ft: number) => ft * FOOT_M
