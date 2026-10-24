/**
 * Canadian Forest Fire Behavior Prediction (FBP) System rate-of-spread equations
 * (Forestry Canada Fire Danger Group 1992, ST-X-3; Wotton, Alexander & Taylor 2009).
 *
 * Simplifications, stated so nobody mistakes this for Prometheus:
 *  - buildup effect (BUI) is not applied (BE = 1): we only have FFMC live, not DMC/DC on the same grid
 *  - slope is ignored (Muskoka is gentle; the hazard raster has no DEM)
 *  - grass curing is fixed at 90 % (autumn)
 *  - M-1/M-2 and D-1/D-2 are picked by season (leafless Oct–Apr)
 */

export interface FbpInputs {
  ffmc: number
  /** 10 m open wind speed, km/h */
  windKmh: number
  /** direction the wind blows FROM, degrees clockwise from north (meteorological convention) */
  windFromDeg: number
  month: number // 1-12
}

/** Fine Fuel Moisture Code → fine fuel moisture function f(F) */
export function ffmcMoistureFunction(ffmc: number): number {
  const m = (147.2 * (101 - ffmc)) / (59.5 + ffmc)
  return 91.9 * Math.exp(-0.1386 * m) * (1 + m ** 5.31 / 4.93e7)
}

export function windFunction(windKmh: number): number {
  return Math.exp(0.05039 * Math.min(windKmh, 40))
}

/** Initial Spread Index */
export function isi(ffmc: number, windKmh: number): number {
  return 0.208 * ffmcMoistureFunction(ffmc) * windFunction(windKmh)
}

type Abc = readonly [a: number, b: number, c: number]
const P: Record<string, Abc> = {
  C1: [90, 0.0649, 4.5],
  C2: [110, 0.0282, 1.5],
  C3: [110, 0.0444, 3.0],
  C4: [110, 0.0293, 1.5],
  C5: [30, 0.0697, 4.0],
  C6: [30, 0.08, 3.0],
  C7: [45, 0.0305, 2.0],
  D1: [30, 0.0232, 1.6],
  M3: [120, 0.0572, 1.4],
  M4: [100, 0.0404, 1.48],
  S1: [75, 0.0297, 1.3],
  S2: [40, 0.0438, 1.7],
  S3: [55, 0.0829, 3.2],
  O1a: [190, 0.031, 1.4],
  O1b: [250, 0.035, 1.7],
}

const basic = ([a, b, c]: Abc, I: number) => a * (1 - Math.exp(-b * I)) ** c

const GRASS_CURING = 90
const curingFactor = (C: number) => (C < 58.8 ? 0.005 * (Math.exp(0.061 * C) - 1) : 0.176 + 0.02 * (C - 58.8))
const leafless = (month: number) => month >= 10 || month <= 4

/**
 * Head-fire rate of spread (m/min) for an Ontario "Hazardous Forest Types" raster code at the given ISI.
 * Codes are FBP fuel types: 1-7 = C-1..C-7, 11/13 = D-1(/D-2), 12 = D-2, 6xx = M-1/M-2 with xx % conifer,
 * 9xx = M-3/M-4 with xx % dead fir, 21-23 = S-1..S-3, 31/32 = O-1a/b, 415 = M-1 15 %, 100-106 = non-fuel/water.
 * Returns 0 for anything that does not carry fire.
 */
export function headRos(code: number, I: number, month: number): number {
  if (code >= 1 && code <= 7) return basic(P[`C${code}`], I)
  if (code === 11 || code === 13) return basic(P.D1, I) * (leafless(month) ? 1 : 0.2)
  if (code === 12) return basic(P.D1, I) * 0.2
  if (code === 415) return mixedwood(15, I, month)
  if (code >= 600 && code < 700) return mixedwood(code - 600, I, month)
  if (code >= 900 && code < 1000) return deadFir(code - 900, I, month)
  if (code === 21) return basic(P.S1, I)
  if (code === 22) return basic(P.S2, I)
  if (code === 23) return basic(P.S3, I)
  if (code === 31) return basic(P.O1a, I) * curingFactor(GRASS_CURING)
  if (code === 32) return basic(P.O1b, I) * curingFactor(GRASS_CURING)
  return 0
}

function mixedwood(pc: number, I: number, month: number): number {
  const conifer = (pc / 100) * basic(P.C2, I)
  const hardwood = ((100 - pc) / 100) * basic(P.D1, I) * (leafless(month) ? 1 : 0.2)
  return conifer + hardwood
}

function deadFir(pdf: number, I: number, month: number): number {
  const fir = (pdf / 100) * basic(leafless(month) ? P.M3 : P.M4, I)
  const rest = ((100 - pdf) / 100) * basic(P.D1, I) * (leafless(month) ? 1 : 0.2)
  return fir + rest
}

/** Length-to-breadth ratio of the fire ellipse (forest fuels); grass uses its own curve. */
export function lengthToBreadth(windKmh: number, grass = false): number {
  if (grass) return windKmh < 1 ? 1 : 1.1 * windKmh ** 0.464
  return 1 + 8.729 * (1 - Math.exp(-0.03 * windKmh)) ** 2.155
}

/**
 * Spread rate in a direction `thetaDeg` away from the head direction, treating the ignition point as the
 * focus of the fire ellipse: r(θ) = a(1 - e²)/(1 - e cos θ), a = ROS/(1 + e), e = sqrt(1 - 1/LB²).
 * θ = 0 gives the head ROS, θ = 180 the back ROS, 90 roughly the flank.
 */
export function directionalRos(headRosMPerMin: number, lb: number, thetaRad: number): number {
  if (headRosMPerMin <= 0) return 0
  const e = Math.sqrt(Math.max(0, 1 - 1 / (lb * lb)))
  const a = headRosMPerMin / (1 + e)
  return (a * (1 - e * e)) / (1 - e * Math.cos(thetaRad))
}

/** Direction the fire head travels (radians, math convention: 0 = east, counter-clockwise), from the wind FROM bearing. */
export function headDirectionRad(windFromDeg: number): number {
  const toDeg = (windFromDeg + 180) % 360 // wind TO bearing, clockwise from north
  return ((90 - toDeg) * Math.PI) / 180
}
