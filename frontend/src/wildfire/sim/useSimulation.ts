import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BuildingRow } from '../types'
import type { FbpInputs } from './fbp'
import { cellOf, lngLatToGrid, type FuelGrid } from './grid'
import type { SimRequest, SimResult } from './protocol'

export const HORIZON_MIN = 12 * 60
export const ISOCHRONES = [60, 180, 360, 720]

export type FuelBreak = [[number, number], [number, number]]

export interface SimActions {
  /** fids whose owners cleared the 30 m Home Ignition Zone */
  cleared: Set<number>
  breaks: FuelBreak[]
}

export interface SimRun {
  result: SimResult
  /** cells sorted by arrival time + their times, for timeline counters and smoke spawning */
  cells: Int32Array
  times: Float32Array
  /** fid -> ignition minute (finite only) */
  ignitedAt: Map<number, number>
  weather: FbpInputs
  ignitionFid: number
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

export function useSimulation(grid: FuelGrid | null, buildings: BuildingRow[]) {
  const workerRef = useRef<Worker | null>(null)
  const runIdRef = useRef(0)
  const pendingRef = useRef<Map<number, { weather: FbpInputs; ignitionFid: number; actions: SimActions }>>(new Map())
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [run, setRun] = useState<SimRun | null>(null)
  const [baseline, setBaseline] = useState<SimRun | null>(null)

  const cells = useMemo(() => {
    if (!grid) return null
    const cell = new Int32Array(buildings.length)
    const exposure = new Float32Array(buildings.length)
    buildings.forEach((b, i) => {
      cell[i] = cellOf(grid, b.lon, b.lat)
      exposure[i] = b.exposure
    })
    return { cell, exposure }
  }, [grid, buildings])

  useEffect(() => {
    const w = new Worker(new URL('./spread.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (ev: MessageEvent<SimResult>) => {
      const res = ev.data
      const meta = pendingRef.current.get(res.runId)
      pendingRef.current.delete(res.runId)
      if (!meta || res.runId !== runIdRef.current) return
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
      setRun(r)
      if (!meta.actions.cleared.size && !meta.actions.breaks.length) setBaseline(r)
      setStatus('done')
    }
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [buildings])

  const simulate = useCallback(
    (ignitionFid: number, weather: FbpInputs, actions: SimActions) => {
      const w = workerRef.current
      if (!w || !grid || !cells) return
      const bi = buildings.findIndex((b) => b.fid === ignitionFid)
      if (bi < 0 || cells.cell[bi] < 0) return
      const cleared = new Uint8Array(buildings.length)
      buildings.forEach((b, i) => {
        if (actions.cleared.has(b.fid)) cleared[i] = 1
      })
      const runId = ++runIdRef.current
      pendingRef.current.set(runId, { weather, ignitionFid, actions })
      const req: SimRequest = {
        type: 'run',
        runId,
        width: grid.width,
        height: grid.height,
        fuel: grid.fuel,
        codes: grid.codes,
        cellM: grid.cellM,
        weather,
        ignitionCell: cells.cell[bi],
        horizonMin: HORIZON_MIN,
        buildingCell: cells.cell,
        buildingExposure: cells.exposure,
        cleared,
        blocked: rasterizeBreaks(grid, actions.breaks),
        isochroneMin: ISOCHRONES,
      }
      setStatus('running')
      w.postMessage(req)
    },
    [grid, cells, buildings],
  )

  const reset = useCallback(() => {
    runIdRef.current++
    setRun(null)
    setBaseline(null)
    setStatus('idle')
  }, [])

  return { status, run, baseline, simulate, reset }
}
