import { useEffect, useState } from 'react'
import { buildFuelGrid, type FuelGrid } from './sim/grid'
import type { BuildingRow, Categories, Coverage, ZoneProps, Zones } from './types'

export const DATA_BASE = '/wildfire/'

export interface WildfireData {
  coverage: Coverage
  categories: Categories
  /** every building in the pilot, sorted by static exposure (highest first) */
  buildings: BuildingRow[]
  byFid: Map<number, BuildingRow>
  grid: FuelGrid | null
  /** high fire-risk zones, most dangerous first */
  zones: Zones
  byZid: Map<number, ZoneProps>
}

async function getJson<T>(name: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(`${DATA_BASE}${name}`, { signal })
  if (!r.ok) throw new Error(`${name} ${r.status}`)
  return r.json() as Promise<T>
}

export function useWildfireData() {
  const [data, setData] = useState<WildfireData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      const [coverage, categories] = await Promise.all([getJson<Coverage>('coverage.json', ctrl.signal), getJson<Categories>('categories.json', ctrl.signal)])
      const [rowsRaw, gridBytes, zones] = await Promise.all([
        getJson<{ fields: string[]; rows: number[][] }>(coverage.files?.buildings ?? 'buildings.json', ctrl.signal),
        coverage.grid
          ? fetch(`${DATA_BASE}${coverage.grid.file}`, { signal: ctrl.signal }).then((r) => {
              if (!r.ok) throw new Error(`${coverage.grid!.file} ${r.status}`)
              return r.arrayBuffer()
            })
          : Promise.resolve(null),
        coverage.zones ? getJson<Zones>(coverage.zones.file, ctrl.signal) : Promise.resolve<Zones>({ type: 'FeatureCollection', features: [] }),
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
      setData({ coverage, categories, buildings, byFid, grid, zones, byZid })
    })().catch((e: unknown) => {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    })
    return () => ctrl.abort()
  }, [])

  return { data, error }
}
