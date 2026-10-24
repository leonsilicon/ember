import type { Pile, SimOptions, SimWorld } from '@rover-brain'

/** The leaf pile every preset shares: 1 m round, 1 m behind the start. */
export const PILE: Pile = { center: [0, 0, 1], radiusM: 1 }

/**
 * Scene templates. The first three are the 2D reference viewer's presets, verbatim; 'Leafy lawn' is a
 * busier yard with more leaves. Leaves are [x, z] in metres on flat ground; the rover starts at the
 * origin facing −z.
 */
export const WORLDS: Record<string, SimWorld> = {
  'Cluttered yard': {
    leaves: [[0, -3], [1.2, -2.6], [-1.5, -3.5], [2.5, -0.5], [-2.2, 0.5], [0.8, -4.2], [-0.6, -1.4], [1.9, -3.8]],
    obstacles: [
      { center: [0, -1.9], radiusM: 0.25, heightM: 1 },
      { center: [1.6, -1.5], radiusM: 0.3, heightM: 0.4 },
      { center: [-1.6, -2.4], radiusM: 0.2, heightM: 1 },
    ],
    pile: PILE,
  },
  'Leaves behind a trunk': {
    leaves: [[0, -3], [0.3, -3.4], [-0.4, -3.2]],
    obstacles: [{ center: [0, -1.6], radiusM: 0.25, heightM: 1 }],
    pile: PILE,
  },
  'Open patch': { leaves: [[0.5, -2], [-1, -1.5], [1.5, -2.5], [-0.3, -3], [2, -1], [-2, -2.5]], pile: PILE },
  'Leafy lawn': {
    leaves: [
      [-0.4, -1.0], [0.3, -2.2], [-2.3, -1.0], [2.4, -1.8], [-1.8, -3.6], [0.2, -4.2], [2.6, -4.3], [-2.8, -2.4],
      [1.9, 0.2], [-2.0, 0.3], [-0.6, -3.0], [1.0, -2.6], [2.8, -0.6], [-1.0, -4.5], [0.6, -3.6], [-2.9, -4.0],
    ],
    obstacles: [
      { center: [-1.2, -2.0], radiusM: 0.22, heightM: 1 },
      { center: [1.4, -3.4], radiusM: 0.25, heightM: 1 },
      { center: [0.9, -1.0], radiusM: 0.25, heightM: 0.35 },
    ],
    pile: PILE,
  },
}

export const DEFAULT_WORLD = 'Cluttered yard'

/** The reference viewer's "Harsh sensors" option. */
export const HARSH_SENSORS: Partial<SimOptions> = { falsePerFrame: 0.3, noisePerM: 0.04, scoopSuccess: 0.7 }

/** The area both views frame, in world metres (x right, z toward the viewer in 2D). */
export const VIEW = { x0: -3.5, x1: 3.5, z0: -5, z1: 2.3 }

export const SPEEDS = [1, 4, 10, 30]
export const DEFAULT_SPEED = 10
