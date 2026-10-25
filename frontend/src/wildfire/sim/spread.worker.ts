/// <reference lib="webworker" />
import { contours } from 'd3-contour'
import { directionalRos, headDirectionRad, headRos, isi as isiOf, lengthToBreadth } from './fbp'
import { CLEARED_FACTOR, IGNITION_FLOOR, type SimRequest, type SimResult } from './protocol'

/**
 * Fire-arrival-time grid by Dijkstra over a 16-neighbour lattice (minimum travel time, the same idea as
 * FARSITE's Huygens front but on cells). Cost of an edge is distance / spread rate in that direction,
 * spread rate from the FBP equations for the fuel in the destination cell plus a structure-to-structure
 * term for cells that hold buildings. Everything is in minutes and metres.
 */

// 16 neighbours: 8 adjacent + 8 knight moves, to reduce the octagonal bias of an 8-neighbour lattice.
const OFF: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
]

class MinHeap {
  private keys: Float32Array
  private vals: Int32Array
  size = 0
  constructor(cap: number) {
    this.keys = new Float32Array(cap)
    this.vals = new Int32Array(cap)
  }
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float32Array(this.size * 2); nk.set(this.keys); this.keys = nk
      const nv = new Int32Array(this.size * 2); nv.set(this.vals); this.vals = nv
    }
    let i = this.size++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= k) break
      this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p]; i = p
    }
    this.keys[i] = k; this.vals[i] = v
  }
  pop(): [number, number] {
    const k = this.keys[0], v = this.vals[0]
    const lk = this.keys[--this.size], lv = this.vals[this.size]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= this.size) break
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++
      if (this.keys[c] >= lk) break
      this.keys[i] = this.keys[c]; this.vals[i] = this.vals[c]; i = c
    }
    this.keys[i] = lk; this.vals[i] = lv
    return [k, v]
  }
}

export function run(req: SimRequest): SimResult {
  const t0 = performance.now()
  const { width, height, fuel, codes, cellM, weather, horizonMin } = req
  const n = width * height
  const I = isiOf(weather.ffmc, weather.windKmh)
  const month = weather.month

  // Head ROS per fuel index, m/min
  const rosByIdx = new Float32Array(codes.length)
  for (let i = 1; i < codes.length; i++) rosByIdx[i] = headRos(codes[i], I, month)
  const grassIdx = new Uint8Array(codes.length)
  for (let i = 1; i < codes.length; i++) grassIdx[i] = codes[i] === 31 || codes[i] === 32 ? 1 : 0

  // Structure term: the hottest home in a cell sets how fast fire hops through that cell (m/min).
  // 0.3-1.0 m/min ≈ 20-60 m/h, the order of magnitude seen for house-to-house spread in WUI fires.
  const structRos = new Float32Array(n)
  const fuelScale = new Float32Array(n).fill(1)
  for (let b = 0; b < req.buildingCell.length; b++) {
    const c = req.buildingCell[b]
    if (c < 0) continue
    const e = req.buildingExposure[b] * (req.cleared[b] ? CLEARED_FACTOR : 1)
    // a home that cannot ignite (below the floor) does not carry fire to its neighbours either
    if (e >= IGNITION_FLOOR) structRos[c] = Math.max(structRos[c], 0.3 + 0.7 * e)
    if (req.cleared[b]) {
      // 30 m zone cleared: this cell and its 8 neighbours lose most of their vegetation fuel
      const row = (c / width) | 0, col = c - row * width
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = row + dr, cc = col + dc
        if (rr >= 0 && cc >= 0 && rr < height && cc < width) fuelScale[rr * width + cc] = 0.15
      }
    }
  }
  const blocked = req.blocked

  const lbForest = lengthToBreadth(weather.windKmh)
  const lbGrass = lengthToBreadth(weather.windKmh, true)
  const lbStruct = Math.min(lbForest, 1.5)
  const head = headDirectionRad(weather.windFromDeg)
  // Per-offset geometry: distance and angle away from the head direction
  const dist = OFF.map(([dx, dy]) => Math.hypot(dx, dy) * cellM)
  const theta = OFF.map(([dx, dy]) => {
    const a = Math.atan2(-dy, dx) // grid rows grow downwards (south)
    let d = a - head
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    return d
  })
  // Directional speed per fuel index per offset (cells share fuel type so cache it)
  const dirRos = new Float32Array(codes.length * OFF.length)
  for (let i = 1; i < codes.length; i++)
    for (let k = 0; k < OFF.length; k++)
      dirRos[i * OFF.length + k] = directionalRos(rosByIdx[i], grassIdx[i] ? lbGrass : lbForest, theta[k])
  const dirStruct = OFF.map((_, k) => directionalRos(1, lbStruct, theta[k]))

  const speedInto = (c: number, k: number): number => {
    if (blocked && blocked[c]) return 0
    const v = dirRos[fuel[c] * OFF.length + k] * fuelScale[c]
    const s = structRos[c] * dirStruct[k]
    return v > s ? v : s
  }

  const arrival = new Float32Array(n).fill(Infinity)
  const done = new Uint8Array(n)
  const heap = new MinHeap(1 << 16)
  if (req.ignitionCell >= 0 && req.ignitionCell < n) {
    arrival[req.ignitionCell] = 0
    heap.push(0, req.ignitionCell)
  }
  let burned = 0
  while (heap.size) {
    const [t, c] = heap.pop()
    if (done[c]) continue
    done[c] = 1
    if (t > horizonMin) break
    burned++
    const row = (c / width) | 0, col = c - row * width
    for (let k = 0; k < OFF.length; k++) {
      const cc = col + OFF[k][0], rr = row + OFF[k][1]
      if (cc < 0 || rr < 0 || cc >= width || rr >= height) continue
      const j = rr * width + cc
      if (done[j]) continue
      const vj = speedInto(j, k)
      if (vj <= 0) continue
      const vi = speedInto(c, k)
      // harmonic mean of the two cell speeds; a non-fuel source cell (e.g. the ignited house's lot) just uses the target
      const dt = vi > 0 ? (dist[k] * (1 / vi + 1 / vj)) / 2 : dist[k] / vj
      const nt = t + dt
      if (nt < arrival[j]) {
        arrival[j] = nt
        heap.push(nt, j)
      }
    }
  }
  // tentative arrivals pushed past the horizon are not burned cells; drop them so every consumer agrees
  for (let i = 0; i < n; i++) if (arrival[i] > horizonMin) arrival[i] = Infinity

  // Homes: ignite when the front reaches their cell, after a delay that shrinks with exposure.
  const ignition = new Float32Array(req.buildingCell.length).fill(Infinity)
  let ignited = 0
  for (let b = 0; b < req.buildingCell.length; b++) {
    const c = req.buildingCell[b]
    if (c < 0) continue
    const e = req.buildingExposure[b] * (req.cleared[b] ? CLEARED_FACTOR : 1)
    if (c !== req.ignitionCell && e < IGNITION_FLOOR) continue
    const t = arrival[c]
    if (!isFinite(t)) continue
    const ig = c === req.ignitionCell ? 0 : t + 60 * (1 - e)
    if (ig <= horizonMin) {
      ignition[b] = ig
      ignited++
    }
  }

  // Isochrones: d3-contour encloses cells with value >= threshold, so contour -arrival at -minutes
  // (unreached = -1e9) to get the polygon of cells reached by each hour rather than its complement.
  const vals = new Float64Array(n)
  for (let i = 0; i < n; i++) vals[i] = isFinite(arrival[i]) ? -arrival[i] : -1e9
  // d3 sorts thresholds ascending, so map the polygons back to the requested order by value
  const gen = contours().size([width, height]).thresholds(req.isochroneMin.map((m) => -m)).smooth(true)
  const byValue = new Map(gen(Array.from(vals)).map((c) => [c.value, c.coordinates]))
  const isochrones = req.isochroneMin.map((m) => ({ type: 'MultiPolygon' as const, coordinates: byValue.get(-m) ?? [] }))

  return {
    type: 'result',
    runId: req.runId,
    arrival,
    ignition,
    isochrones,
    burnedCells: burned,
    burnedHa: (burned * cellM * cellM) / 10_000,
    ignitedHomes: ignited,
    headRosMPerMin: Math.max(...Array.from(rosByIdx)),
    isi: I,
    elapsedMs: performance.now() - t0,
  }
}

// guarded so the solver can be imported by unit tests outside a worker
if (typeof self !== 'undefined' && 'postMessage' in self) {
  self.onmessage = (ev: MessageEvent<SimRequest>) => {
    if (ev.data.type !== 'run') return
    const res = run(ev.data)
    ;(self as unknown as Worker).postMessage(res, [res.arrival.buffer, res.ignition.buffer])
  }
}
