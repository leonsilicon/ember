import type { MultiPolygon } from 'geojson'
import type { FbpInputs } from './fbp'

export interface SimRequest {
  type: 'run'
  runId: number
  width: number
  height: number
  fuel: Uint8Array
  codes: Int32Array
  cellM: number
  weather: FbpInputs
  ignitionCell: number
  horizonMin: number
  /** per building: grid cell (-1 if outside) and static exposure 0-1 */
  buildingCell: Int32Array
  buildingExposure: Float32Array
  /** per building: 1 = owner has cleared the 30 m Home Ignition Zone */
  cleared: Uint8Array
  /** per cell: 1 = fuel break (no fuel carries fire through this cell) */
  blocked: Uint8Array | null
  /** minutes at which to draw isochrones */
  isochroneMin: number[]
}

export interface SimResult {
  type: 'result'
  runId: number
  /** minutes until the fire front arrives in each cell; Infinity if never within horizon */
  arrival: Float32Array
  /** minutes until each building ignites; Infinity = survives */
  ignition: Float32Array
  /** grid-space multipolygons (col,row) per isochrone threshold, same order as request.isochroneMin */
  isochrones: MultiPolygon[]
  burnedCells: number
  burnedHa: number
  ignitedHomes: number
  headRosMPerMin: number
  isi: number
  elapsedMs: number
}

/** Many what-if runs that differ only in actions; used to search for the most useful mitigation. */
export interface BatchRequest {
  type: 'batch'
  batchId: number
  base: SimRequest
  variants: { id: number; cleared: Uint8Array; blocked: Uint8Array | null }[]
}

export interface BatchResult {
  type: 'batch'
  batchId: number
  results: { id: number; ignitedHomes: number; burnedHa: number }[]
  elapsedMs: number
}

/** Exposure below which a home does not ignite even when the front passes (FireSmart "clean zone"). */
export const IGNITION_FLOOR = 0.2
/** Fraction of exposure left after clearing the 30 m Home Ignition Zone. */
export const CLEARED_FACTOR = 0.3
