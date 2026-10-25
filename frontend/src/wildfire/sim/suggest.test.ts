import { describe, expect, it } from 'bun:test'
import { gridToLngLat, lngLatToGrid } from './grid'
import { MIN_REACH_MIN, candidates, compass, rank, traceBack, waterEdge } from './suggest'

const W = 60, H = 60
const grid = { width: W, height: H, origin: [-8800000, 5650000] as [number, number], res: 42, cellM: 30 }

/** Arrival = distance in cells from an ignition at (col 5, row 30): a fire moving east. */
function eastwardFire() {
  const arrival = new Float32Array(W * H)
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) arrival[r * W + c] = Math.hypot(c - 5, r - 30) * 10
  return { arrival, ignitionCell: 30 * W + 5 }
}

describe('compass', () => {
  it('maps grid directions to names (rows grow south)', () => {
    expect(compass(0, -1)).toBe('north')
    expect(compass(1, 0)).toBe('east')
    expect(compass(0, 1)).toBe('south')
    expect(compass(-1, 0)).toBe('west')
    expect(compass(1, 1)).toBe('south-east')
  })
})

describe('traceBack', () => {
  it('walks down the arrival surface towards the ignition', () => {
    const { arrival, ignitionCell } = eastwardFire()
    const start = 30 * W + 45
    const path = traceBack(arrival, W, H, start, 100)
    expect(path[0]).toBe(start)
    expect(path.at(-1)).toBe(ignitionCell)
    for (let i = 1; i < path.length; i++) expect(arrival[path[i]]).toBeLessThan(arrival[path[i - 1]])
  })
})

describe('candidates', () => {
  const { arrival, ignitionCell } = eastwardFire()
  const homes = [30 * W + 45, 10 * W + 50, 30 * W + 46]
  const ignition = Float32Array.from(homes.map((c) => arrival[c] + 5))
  const base = { grid, arrival, ignition, buildingCell: Int32Array.from(homes), fids: [11, 22, 33], ignitionCell, cleared: new Set<number>() }

  it('puts breaks upwind of the first homes, across the direction of travel', () => {
    const cs = candidates(base)
    const breaks = cs.filter((c) => c.kind === 'break')
    // home 33 is next to 11, so only 11 and 22 are targets; 3 distances x 2 lengths each
    expect(new Set(breaks.map((b) => b.targetFid))).toEqual(new Set([11, 22]))
    expect(breaks.length).toBe(12)
    for (const b of breaks) expect(b.reachMin!).toBeGreaterThanOrEqual(MIN_REACH_MIN)
    const b = breaks.find((x) => x.targetFid === 11 && x.lengthM === 600)!
    expect(b.side).toBe('west')
    expect(b.reachMin!).toBeLessThan(b.homeMin)
    const [a, z] = b.brk!.map(([lon, lat]) => lngLatToGrid(grid, lon, lat))
    // fire travels east along row 30, so the break runs north-south: same column, 20 cells long
    expect(Math.abs(a[0] - z[0])).toBeLessThan(0.01)
    expect(Math.abs(a[1] - z[1])).toBeCloseTo(600 / 30, 1)
    expect(a[0]).toBeLessThan(45)
  })

  it('skips break lines the fire reaches within the first hour', () => {
    const near = [30 * W + 9]
    const cs = candidates({ ...base, buildingCell: Int32Array.from(near), ignition: Float32Array.from([arrival[near[0]] + 5]), fids: [5] })
    expect(cs.filter((c) => c.kind === 'break').length).toBe(0)
  })

  it('offers clearing the first homes, skipping already cleared ones and the ignition home', () => {
    const cs = candidates({ ...base, cleared: new Set([11]) })
    const clear = cs.filter((c) => c.kind === 'clear')
    expect(clear.length).toBe(1)
    expect(clear[0].clear).toEqual([33, 22])
  })

  it('round-trips grid coordinates', () => {
    const [lon, lat] = gridToLngLat(grid, 12.5, 7.25)
    const [c, r] = lngLatToGrid(grid, lon, lat)
    expect(c).toBeCloseTo(12.5, 6)
    expect(r).toBeCloseTo(7.25, 6)
  })
})

describe('rank', () => {
  it('keeps savers only, one per protected home, best first', () => {
    const cs = [
      { id: 0, kind: 'break' as const, targetFid: 1, lengthM: 600, homeMin: 100 },
      { id: 1, kind: 'break' as const, targetFid: 1, lengthM: 1200, homeMin: 100 },
      { id: 2, kind: 'break' as const, targetFid: 2, lengthM: 600, homeMin: 100 },
      { id: 3, kind: 'clear' as const, clear: [1, 2], homeMin: 100 },
    ]
    const r = rank(cs, [{ id: 0, ignitedHomes: 7 }, { id: 1, ignitedHomes: 7 }, { id: 2, ignitedHomes: 10 }, { id: 3, ignitedHomes: 4 }], 10)
    expect(r.map((s) => [s.id, s.saved])).toEqual([[3, 6], [0, 3]])
  })
})

describe('waterEdge', () => {
  it('reports the side where water stops the fire', () => {
    const arrival = new Float32Array(W * H).fill(Infinity)
    const fuel = new Uint8Array(W * H).fill(1)
    for (let r = 20; r < 40; r++) for (let c = 20; c < 40; c++) arrival[r * W + c] = 1
    for (let r = 0; r < H; r++) fuel[r * W + 40] = 9 // a lake along the east edge of the burn
    const e = waterEdge(arrival, fuel, (i) => i === 9, W, H, 30 * W + 30)
    expect(e).not.toBeNull()
    expect(e!.side).toBe('east')
    expect(e!.share).toBeCloseTo(20 / 80, 2)
    expect(waterEdge(arrival, new Uint8Array(W * H).fill(1), (i) => i === 9, W, H, 30 * W + 30)).toBeNull()
  })
})
