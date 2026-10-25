import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BuildingRow } from '../types'
import type { FbpInputs } from './fbp'
import { cellOf, lngLatToGrid, type FuelGrid } from './grid'
import type { BatchRequest, BatchResult, SimRequest, SimResult } from './protocol'
import { candidates, rank, type Suggestion } from './suggest'

export const HORIZON_MIN = 12 * 60
export const ISOCHRONES = [60, 180, 360, 720]

export type FuelBreak = [[number, number], [number, number]]

export interface SimActions {
  /** fids whose owners cleared the 30 m Home Ignition Zone */
  cleared: Set<number>
  breaks: FuelBreak[]
}

/** Where a run starts: a home (its lot ignites) or any grid cell (random / clicked / a zone). */
export type Ignition =
  | { kind: 'home'; fid: number; lon: number; lat: number }
  | { kind: 'point'; cell: number; lon: number; lat: number; zid?: number }

export const ignitionKey = (i: Ignition) => (i.kind === 'home' ? `home:${i.fid}` : `cell:${i.cell}`)

export interface SimRun {
  result: SimResult
  /** cells sorted by arrival time + their times, for timeline counters and smoke spawning */
  cells: Int32Array
  times: Float32Array
  /** fid -> ignition minute (finite only) */
  ignitedAt: Map<number, number>
  weather: FbpInputs
  ignition: Ignition
  ignitionCell: number
  actions: SimActions
}

export function lowerBound(a: Float32Array, v: number) {
  let lo = 0, hi = a.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (a[m] < v) lo = m + 1
    else hi = m
  }
  return lo
}

/** Cells within 1 cell (≈ 90 m total width) of the segment, as a sparse blocked mask. */
export function rasterizeBreaks(grid: FuelGrid, breaks: FuelBreak[]): Uint8Array | null {
  if (!breaks.length) return null
  const mask = new Uint8Array(grid.width * grid.height)
  for (const [a, b] of breaks) {
    const [c0, r0] = lngLatToGrid(grid, a[0], a[1])
    const [c1, r1] = lngLatToGrid(grid, b[0], b[1])
    const steps = Math.max(1, Math.ceil(Math.hypot(c1 - c0, r1 - r0) * 2))
    for (let s = 0; s <= steps; s++) {
      const c = Math.floor(c0 + ((c1 - c0) * s) / steps), r = Math.floor(r0 + ((r1 - r0) * s) / steps)
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc
          if (rr >= 0 && cc >= 0 && rr < grid.height && cc < grid.width) mask[rr * grid.width + cc] = 1
        }
    }
  }
  return mask
}

export interface SuggestState {
  status: 'running' | 'done'
  /** the run the suggestions were computed against */
  forRun: SimRun
  items: Suggestion[]
  tested: number
  elapsedMs: number
}

function clearedMask(buildings: BuildingRow[], cleared: Set<number>) {
  const m = new Uint8Array(buildings.length)
  buildings.forEach((b, i) => {
    if (cleared.has(b.fid)) m[i] = 1
  })
  return m
}

const NO_ACTIONS: SimActions = { cleared: new Set(), breaks: [] }
const sameWeather = (a: FbpInputs, b: FbpInputs) =>
  a.ffmc === b.ffmc && a.windKmh === b.windKmh && a.windFromDeg === b.windFromDeg && a.month === b.month

export function useSimulation(grid: FuelGrid | null, buildings: BuildingRow[]) {
  const workerRef = useRef<Worker | null>(null)
  const runIdRef = useRef(0)
  const baseRunIdRef = useRef(0)
  const pendingRef = useRef<Map<number, { weather: FbpInputs; ignition: Ignition; ignitionCell: number; actions: SimActions }>>(new Map())
  const batchWorkerRef = useRef<Worker | null>(null)
  const batchIdRef = useRef(0)
  const batchDoneRef = useRef<(res: BatchResult) => void>(() => {})
  const [suggest, setSuggest] = useState<SuggestState | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [run, setRun] = useState<SimRun | null>(null)
  const [baseline, setBaseline] = useState<SimRun | null>(null)
  const baselineRef = useRef<SimRun | null>(null)
  useEffect(() => {
    baselineRef.current = baseline
  }, [baseline])

  const cells = useMemo(() => {
    if (!grid) return null
    const cell = new Int32Array(buildings.length)
    const exposure = new Float32Array(buildings.length)
    buildings.forEach((b, i) => {
      cell[i] = cellOf(grid, b.lon, b.lat)
      exposure[i] = b.exposure
    })
    return { cell, exposure, indexOf: new Map(buildings.map((b, i) => [b.fid, i])) }
  }, [grid, buildings])

  const makeRequest = useCallback(
    (runId: number, ignitionCell: number, weather: FbpInputs, acts: SimActions, isochroneMin = ISOCHRONES): SimRequest | null => {
      if (!grid || !cells) return null
      return {
        type: 'run',
        runId,
        width: grid.width,
        height: grid.height,
        fuel: grid.fuel,
        codes: grid.codes,
        cellM: grid.cellM,
        weather,
        ignitionCell,
        horizonMin: HORIZON_MIN,
        buildingCell: cells.cell,
        buildingExposure: cells.exposure,
        cleared: clearedMask(buildings, acts.cleared),
        blocked: rasterizeBreaks(grid, acts.breaks),
        isochroneMin,
      }
    },
    [grid, cells, buildings],
  )

  useEffect(() => {
    const w = new Worker(new URL('./spread.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (ev: MessageEvent<SimResult>) => {
      const res = ev.data
      const meta = pendingRef.current.get(res.runId)
      pendingRef.current.delete(res.runId)
      const isMain = res.runId === runIdRef.current, isBase = res.runId === baseRunIdRef.current
      if (!meta || (!isMain && !isBase)) return
      const n = res.arrival.length
      const idx: number[] = []
      for (let i = 0; i < n; i++) if (isFinite(res.arrival[i])) idx.push(i)
      idx.sort((a, b) => res.arrival[a] - res.arrival[b])
      const sorted = Int32Array.from(idx)
      const times = Float32Array.from(idx, (i) => res.arrival[i])
      const ignitedAt = new Map<number, number>()
      res.ignition.forEach((t, i) => {
        if (isFinite(t)) ignitedAt.set(buildings[i].fid, t)
      })
      const r: SimRun = { result: res, cells: sorted, times, ignitedAt, ...meta }
      if (isBase) setBaseline(r)
      if (isMain) {
        setRun(r)
        if (!meta.actions.cleared.size && !meta.actions.breaks.length) setBaseline(r)
        setStatus('done')
      }
    }
    return () => {
      w.terminate()
      workerRef.current = null
      batchWorkerRef.current?.terminate()
      batchWorkerRef.current = null
    }
  }, [buildings])

  const cellOfIgnition = useCallback(
    (ign: Ignition) => {
      if (!cells) return -1
      if (ign.kind === 'point') return ign.cell
      const bi = cells.indexOf.get(ign.fid)
      return bi == null ? -1 : cells.cell[bi]
    },
    [cells],
  )

  const simulate = useCallback(
    (ignition: Ignition, weather: FbpInputs, actions: SimActions) => {
      const w = workerRef.current
      if (!w) return
      const ignitionCell = cellOfIgnition(ignition)
      if (ignitionCell < 0) return
      const post = (runId: number, acts: SimActions) => {
        const req = makeRequest(runId, ignitionCell, weather, acts)
        if (!req) return
        pendingRef.current.set(runId, { weather, ignition, ignitionCell, actions: acts })
        w.postMessage(req)
      }
      const hasActions = actions.cleared.size > 0 || actions.breaks.length > 0
      // "Homes saved" must compare against an untouched run with the *same* weather and ignition point
      const base = baselineRef.current
      if (hasActions && (!base || ignitionKey(base.ignition) !== ignitionKey(ignition) || !sameWeather(base.weather, weather))) post(++baseRunIdRef.current, NO_ACTIONS)
      post(++runIdRef.current, actions)
      setStatus('running')
    },
    [cellOfIgnition, makeRequest],
  )

  /** Try candidate fuel breaks / clearings on top of `r`'s actions and keep the ones that save the most homes. */
  const findSuggestions = useCallback(
    (r: SimRun) => {
      if (!grid || !cells) return
      const base = makeRequest(0, r.ignitionCell, r.weather, r.actions, [])
      if (!base) return
      const cands = candidates({
        grid,
        arrival: r.result.arrival,
        ignition: r.result.ignition,
        buildingCell: cells.cell,
        fids: buildings.map((b) => b.fid),
        ignitionCell: r.ignitionCell,
        cleared: r.actions.cleared,
      })
      const batchId = ++batchIdRef.current
      setSuggest({ status: 'running', forRun: r, items: [], tested: cands.length, elapsedMs: 0 })
      if (!cands.length) {
        setSuggest({ status: 'done', forRun: r, items: [], tested: 0, elapsedMs: 0 })
        return
      }
      batchDoneRef.current = (res) => {
        if (res.batchId !== batchIdRef.current) return
        setSuggest({ status: 'done', forRun: r, items: rank(cands, res.results, r.result.ignitedHomes), tested: cands.length, elapsedMs: res.elapsedMs })
      }
      let w = batchWorkerRef.current
      if (!w) {
        w = new Worker(new URL('./spread.worker.ts', import.meta.url), { type: 'module' })
        w.onmessage = (ev: MessageEvent<BatchResult>) => batchDoneRef.current(ev.data)
        batchWorkerRef.current = w
      }
      const req: BatchRequest = {
        type: 'batch',
        batchId,
        base,
        variants: cands.map((c) => ({
          id: c.id,
          cleared: clearedMask(buildings, c.clear ? new Set([...r.actions.cleared, ...c.clear]) : r.actions.cleared),
          blocked: rasterizeBreaks(grid, c.brk ? [...r.actions.breaks, c.brk] : r.actions.breaks),
        })),
      }
      w.postMessage(req)
    },
    [grid, cells, buildings, makeRequest],
  )

  const reset = useCallback(() => {
    runIdRef.current++
    baseRunIdRef.current++
    batchIdRef.current++
    setRun(null)
    setBaseline(null)
    setSuggest(null)
    setStatus('idle')
  }, [])

  return { status, run, baseline, simulate, reset, suggest, findSuggestions }
}
