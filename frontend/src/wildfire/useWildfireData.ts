import { useEffect, useState } from 'react'
import { buildFuelGrid, type FuelGrid } from './sim/grid'
import type { Area, BuildingRow, Categories, Coverage, DensityAreas, DensityProps, Roads, ZoneProps, Zones } from './types'

export const DATA_BASE = '/wildfire/'
const EMPTY: Zones = { type: 'FeatureCollection', features: [] }

export interface WildfireData {
  base: string
  coverage: Coverage
  categories: Categories
  /** every building in the pilot, sorted by static exposure (highest first) */
  buildings: BuildingRow[]
  byFid: Map<number, BuildingRow>
  grid: FuelGrid | null
  /** high fire-risk zones, most dangerous first */
  zones: Zones
  byZid: Map<number, ZoneProps>
  density: DensityAreas
  byDid: Map<number, DensityProps>
  /** drivable roads, for back-burn anchors */
  roads: Roads
}

async function getJson<T>(name: string, signal: AbortSignal, base = DATA_BASE): Promise<T> {
  const r = await fetch(`${base}${name}`, { signal })
  if (!r.ok) throw new Error(`${name} ${r.status}`)
  return r.json() as Promise<T>
}

/** The areas the app ships (areas.json); the first is the default. */
export function useAreas() {
  const [areas, setAreas] = useState<Area[]>([])
  useEffect(() => {
    const ctrl = new AbortController()
    getJson<{ areas: Area[] }>('areas.json', ctrl.signal)
      .then((a) => setAreas(a.areas))
      .catch(() => setAreas([{ id: 'default', name: 'Pilot area', base: DATA_BASE }]))
    return () => ctrl.abort()
  }, [])
  return areas
}

export function useWildfireData(base: string | null) {
  const [loaded, setLoaded] = useState<WildfireData | null>(null)
  const [error, setError] = useState<string | null>(null)
  // data for another area is stale the moment the area changes; never hand it out
  const data = loaded && loaded.base === base ? loaded : null

  useEffect(() => {
    if (!base) return
    const ctrl = new AbortController()
    const get = <T,>(name: string) => getJson<T>(name, ctrl.signal, base)
    ;(async () => {
      const [coverage, categories] = await Promise.all([get<Coverage>('coverage.json'), get<Categories>('categories.json')])
      const [rowsRaw, gridBytes, zones, density, roads] = await Promise.all([
        get<{ fields: string[]; rows: number[][] }>(coverage.files?.buildings ?? 'buildings.json'),
        coverage.grid
          ? fetch(`${base}${coverage.grid.file}`, { signal: ctrl.signal }).then((r) => {
              if (!r.ok) throw new Error(`${coverage.grid!.file} ${r.status}`)
              return r.arrayBuffer()
            })
          : Promise.resolve(null),
        coverage.zones ? get<Zones>(coverage.zones.file) : Promise.resolve(EMPTY),
        coverage.density ? get<DensityAreas>(coverage.density.file) : Promise.resolve(EMPTY as unknown as DensityAreas),
        coverage.roads ? get<Roads>(coverage.roads.file) : Promise.resolve(EMPTY as unknown as Roads),
      ])
      const f = rowsRaw.fields
      const ix = (k: string) => f.indexOf(k)
      const [iFid, iLon, iLat, iE, iF, iL, iN, iA] = ['fid', 'lon', 'lat', 'exposure', 'f_fuel', 'l_leafoff', 'n_neighbours', 'area_m2'].map(ix)
      const buildings: BuildingRow[] = rowsRaw.rows.map((r) => ({
        fid: r[iFid], lon: r[iLon], lat: r[iLat], exposure: r[iE], f_fuel: r[iF], l_leafoff: r[iL], n_neighbours: r[iN], area_m2: r[iA],
      }))
      buildings.sort((a, b) => b.exposure - a.exposure)
      const byFid = new Map(buildings.map((b) => [b.fid, b]))
      const grid = coverage.grid && gridBytes ? buildFuelGrid(coverage.grid, gridBytes) : null
      const byZid = new Map(zones.features.map((z) => [z.properties.zid, z.properties]))
      const byDid = new Map(density.features.map((d) => [d.properties.did, d.properties]))
      setLoaded({ base, coverage, categories, buildings, byFid, grid, zones, byZid, density, byDid, roads })
    })().catch((e: unknown) => {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    })
    return () => ctrl.abort()
  }, [base])

  return { data, error }
}
