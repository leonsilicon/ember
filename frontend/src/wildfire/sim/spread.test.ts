import { describe, expect, it } from 'vitest'
import { IGNITION_FLOOR, type SimRequest } from './protocol'
import { run } from './spread.worker'

const W = 80, H = 80
function req(over: Partial<SimRequest> = {}): SimRequest {
  const centre = 40 * W + 40
  return {
    type: 'run',
    runId: 1,
    width: W,
    height: H,
    fuel: new Uint8Array(W * H).fill(1),
    codes: Int32Array.from([0, 2]), // index 1 = C-2 boreal spruce
    cellM: 30,
    weather: { ffmc: 88, windKmh: 8, windFromDeg: 270, month: 10 },
    ignitionCell: centre,
    horizonMin: 720,
    buildingCell: Int32Array.from([centre + 2, centre + 3]),
    buildingExposure: Float32Array.from([IGNITION_FLOOR - 0.05, 0.6]),
    cleared: new Uint8Array(2),
    blocked: null,
    isochroneMin: [60, 180],
    ...over,
  }
}

describe('spread worker', () => {
  it('burned cells are exactly the finite arrivals, all within the horizon', () => {
    const r = run(req())
    let finite = 0
    for (const t of r.arrival) if (isFinite(t)) { finite++; expect(t).toBeLessThanOrEqual(720) }
    expect(finite).toBe(r.burnedCells)
    expect(r.burnedCells).toBeGreaterThan(50)
  })

  it('isochrone encloses the reached area, not its complement', () => {
    const r = run(req())
    const ring = r.isochrones[0].coordinates[0][0]
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1])
    expect(Math.min(...xs)).toBeGreaterThan(0)
    expect(Math.max(...xs)).toBeLessThan(W)
    expect(Math.min(...ys)).toBeGreaterThan(0)
    expect(Math.max(...ys)).toBeLessThan(H)
    expect(Math.min(...xs)).toBeLessThan(40)
    expect(Math.max(...xs)).toBeGreaterThan(40)
    // the 1 h ring sits inside the 3 h ring
    const ring3 = r.isochrones[1].coordinates[0][0]
    expect(Math.max(...ring3.map((p) => p[0]))).toBeGreaterThan(Math.max(...xs))
  })

  it('homes below the ignition floor never ignite; the ignition home always does', () => {
    const r = run(req())
    expect(r.ignition[0]).toBe(Infinity)
    expect(r.ignition[1]).toBeGreaterThan(0)
    expect(r.ignitedHomes).toBe(1)
    const centre = 40 * W + 40
    const r2 = run(req({ buildingCell: Int32Array.from([centre]), buildingExposure: Float32Array.from([0.05]), cleared: new Uint8Array(1) }))
    expect(r2.ignition[0]).toBe(0)
    expect(r2.ignitedHomes).toBe(1)
  })

  it('a drawn fuel break stops the fire', () => {
    const blocked = new Uint8Array(W * H)
    for (let r = 0; r < H; r++) for (let c = 50; c <= 52; c++) blocked[r * W + c] = 1
    const r = run(req({ blocked, weather: { ffmc: 92, windKmh: 30, windFromDeg: 270, month: 10 } }))
    for (let row = 0; row < H; row++) for (let c = 53; c < W; c++) expect(r.arrival[row * W + c]).toBe(Infinity)
  })
})
