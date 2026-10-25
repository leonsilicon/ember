import { gridToLngLat, type FuelGrid } from './grid'
import type { FuelBreak } from './useSimulation'

/**
 * Mitigation search. From the no-action fire we propose a handful of actions a crew could take, then re-run
 * the same fire with each one (runBatch in the worker) and keep the few that save the most homes:
 *  - a 90 m fuel break across the fire's path, a few hundred metres before it reaches the first homes it
 *    would ignite (the path is traced back from each home down the arrival-time surface), and no sooner than
 *    MIN_REACH_MIN after ignition so a crew could get there;
 *  - clearing the 30 m Home Ignition Zone of the first homes to ignite.
 */

export interface Candidate {
  id: number
  kind: 'break' | 'clear'
  brk?: FuelBreak
  lengthM?: number
  /** fids whose 30 m zone gets cleared */
  clear?: number[]
  /** home the break protects: the first to ignite behind it */
  targetFid?: number
  /** minutes until the fire reaches the break line (no action) */
  reachMin?: number
  /** minutes until the protected home (or the first of the cleared ones) ignites (no action) */
  homeMin: number
  /** side of the home the fire comes from, e.g. "west" */
  side?: string
  /** distance from that home to the break */
  distM?: number
}

export interface Suggestion extends Candidate {
  saved: number
}

type Geo = Pick<FuelGrid, 'width' | 'height' | 'origin' | 'res' | 'cellM'>

export interface CandidateInput {
  grid: Geo
  arrival: Float32Array
  /** per building index: ignition minute, Infinity = survives */
  ignition: Float32Array
  buildingCell: Int32Array
  fids: number[]
  ignitionCell: number
  cleared: Set<number>
}

const SIDES = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

/** Compass name of a grid direction (columns grow east, rows grow south). */
export function compass(dCol: number, dRow: number): string {
  const deg = ((Math.atan2(dCol, -dRow) * 180) / Math.PI + 360) % 360
  return SIDES[Math.round(deg / 45) % 8]
}

/** Cells from `start` back towards the ignition, always stepping to the earliest-burning neighbour. */
export function traceBack(arrival: Float32Array, width: number, height: number, start: number, maxSteps: number): number[] {
  const path = [start]
  let c = start
  for (let s = 0; s < maxSteps; s++) {
    const row = (c / width) | 0, col = c - row * width
    let best = -1, bt = arrival[c]
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const rr = row + dr, cc = col + dc
        if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue
        const j = rr * width + cc
        if (arrival[j] < bt) {
          bt = arrival[j]
          best = j
        }
      }
    if (best < 0) break
    path.push(best)
    c = best
  }
  return path
}

const BACK_CELLS = [6, 12, 20] // ~180, 360 and 600 m before the home
const LENGTHS_M = [600, 1200]
const TARGET_SPACING_CELLS = 15
const MAX_TARGETS = 5
/** a crew needs time to get there: skip lines the fire reaches sooner than this */
export const MIN_REACH_MIN = 60

export function candidates(inp: CandidateInput): Candidate[] {
  const { grid, arrival, ignition, buildingCell, fids, ignitionCell, cleared } = inp
  const { width, height } = grid
  const order: number[] = []
  for (let i = 0; i < ignition.length; i++) if (isFinite(ignition[i]) && buildingCell[i] >= 0 && buildingCell[i] !== ignitionCell) order.push(i)
  order.sort((a, b) => ignition[a] - ignition[b])
  const out: Candidate[] = []
  let id = 0

  const targets: number[] = []
  for (const i of order) {
    if (targets.length >= MAX_TARGETS) break
    const c = buildingCell[i]
    const r = (c / width) | 0, col = c - r * width
    const far = targets.every((j) => {
      const cj = buildingCell[j], rj = (cj / width) | 0
      return Math.hypot(col - (cj - rj * width), r - rj) >= TARGET_SPACING_CELLS
    })
    if (far) targets.push(i)
  }
  for (const i of targets) {
    const hc = buildingCell[i]
    const path = traceBack(arrival, width, height, hc, Math.max(...BACK_CELLS))
    const hr = (hc / width) | 0, hcol = hc - hr * width
    for (const back of BACK_CELLS) {
      if (path.length <= back) continue
      const p = path[back]
      if (p === ignitionCell || !isFinite(arrival[p]) || arrival[p] < MIN_REACH_MIN) continue
      const pr = (p / width) | 0, pc = p - pr * width
      const dc = hcol - pc, dr = hr - pr
      const len = Math.hypot(dc, dr)
      if (len === 0) continue
      const nc = -dr / len, nr = dc / len // perpendicular to the direction of travel
      for (const lengthM of LENGTHS_M) {
        const half = lengthM / 2 / grid.cellM
        const a = gridToLngLat(grid, pc + 0.5 + nc * half, pr + 0.5 + nr * half)
        const b = gridToLngLat(grid, pc + 0.5 - nc * half, pr + 0.5 - nr * half)
        out.push({
          id: id++,
          kind: 'break',
          brk: [a, b],
          lengthM,
          targetFid: fids[i],
          reachMin: arrival[p],
          homeMin: ignition[i],
          side: compass(-dc, -dr),
          distM: Math.round(len * grid.cellM),
        })
      }
    }
  }

  const first = order.map((i) => fids[i]).filter((f) => !cleared.has(f))
  for (const n of [10, 25]) {
    if (!first.length) break
    const clear = first.slice(0, n)
    out.push({ id: id++, kind: 'clear', clear, homeMin: ignition[order.find((i) => fids[i] === clear[0])!] })
    if (first.length <= n) break
  }
  return out
}

/** Best few candidates that save at least one home: one per protected home, one clearing option. */
export function rank(cands: Candidate[], results: { id: number; ignitedHomes: number }[], ignitedNow: number, max = 3): Suggestion[] {
  const byId = new Map(results.map((r) => [r.id, r.ignitedHomes]))
  const scored: Suggestion[] = []
  for (const c of cands) {
    const ig = byId.get(c.id)
    if (ig == null) continue
    const saved = ignitedNow - ig
    if (saved > 0) scored.push({ ...c, saved })
  }
  scored.sort((a, b) => b.saved - a.saved || (a.lengthM ?? 0) - (b.lengthM ?? 0) || (a.clear?.length ?? 0) - (b.clear?.length ?? 0))
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const s of scored) {
    const key = s.kind === 'break' ? `break:${s.targetFid}` : 'clear'
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * How much of the fire's 12 h edge is water: unburned water cells touching burned cells, and the side of the
 * ignition they lie on. Null when water stops less than `minShare` of the edge.
 */
export function waterEdge(
  arrival: Float32Array,
  fuel: Uint8Array,
  isWater: (fuelIndex: number) => boolean,
  width: number,
  height: number,
  ignitionCell: number,
  minShare = 0.15,
): { share: number; side: string } | null {
  let edge = 0, water = 0, sc = 0, sr = 0
  const ir = (ignitionCell / width) | 0, ic = ignitionCell - ir * width
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const i = r * width + c
      if (isFinite(arrival[i])) continue
      const touches =
        (c > 0 && isFinite(arrival[i - 1])) || (c < width - 1 && isFinite(arrival[i + 1])) || (r > 0 && isFinite(arrival[i - width])) || (r < height - 1 && isFinite(arrival[i + width]))
      if (!touches) continue
      edge++
      if (isWater(fuel[i])) {
        water++
        sc += c - ic
        sr += r - ir
      }
    }
  if (!edge || water / edge < minShare || water < 10) return null
  return { share: water / edge, side: compass(sc, sr) }
}
