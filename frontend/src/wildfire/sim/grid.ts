import type { Coverage } from '../types'

const R = 6378137

export interface FuelGrid {
  width: number
  height: number
  /** 1-based fuel index per cell, 0 = outside raster */
  fuel: Uint8Array
  /** index -> Ontario raster code (index 0 unused) */
  codes: Int32Array
  /** Web Mercator origin (top-left) and cell size in metres (mercator units) */
  origin: [number, number]
  res: number
  cellM: number
}

export function buildFuelGrid(grid: NonNullable<Coverage['grid']>, bytes: ArrayBuffer): FuelGrid {
  const codes = new Int32Array(grid.codes.length + 1)
  for (const c of grid.codes) codes[c.index] = c.code
  return { width: grid.width, height: grid.height, fuel: new Uint8Array(bytes), codes, origin: grid.origin, res: grid.res, cellM: grid.cell_m }
}

export function lngLatToMerc(lon: number, lat: number): [number, number] {
  const x = (R * lon * Math.PI) / 180
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return [x, y]
}

export function mercToLngLat(x: number, y: number): [number, number] {
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)]
}

/** Grid coordinate (fractional column, row) of a lon/lat; may fall outside [0,width)x[0,height). */
export function lngLatToGrid(g: Pick<FuelGrid, 'origin' | 'res'>, lon: number, lat: number): [number, number] {
  const [x, y] = lngLatToMerc(lon, lat)
  return [(x - g.origin[0]) / g.res, (g.origin[1] - y) / g.res]
}

export function gridToLngLat(g: Pick<FuelGrid, 'origin' | 'res'>, col: number, row: number): [number, number] {
  return mercToLngLat(g.origin[0] + col * g.res, g.origin[1] - row * g.res)
}

export function cellOf(g: Pick<FuelGrid, 'origin' | 'res' | 'width' | 'height'>, lon: number, lat: number): number {
  const [c, r] = lngLatToGrid(g, lon, lat)
  const col = Math.floor(c), row = Math.floor(r)
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return -1
  return row * g.width + col
}

/** Geographic bounds of the whole grid as [[w,s],[e,n]] — what the fire texture is draped over. */
export function gridBounds(g: FuelGrid): [[number, number], [number, number]] {
  const [w, n] = mercToLngLat(g.origin[0], g.origin[1])
  const [e, s] = mercToLngLat(g.origin[0] + g.width * g.res, g.origin[1] - g.height * g.res)
  return [[w, s], [e, n]]
}
