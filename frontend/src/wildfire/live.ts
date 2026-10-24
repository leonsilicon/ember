import { useEffect, useState } from 'react'

export const CWFIS_WMS = 'https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wms'
export const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'

export interface Dryness {
  ffmc: number | null
  fwi: number | null
  fdr: number | null
  dc: number | null
  date: string
}

const FDR_LABEL = ['—', 'Low', 'Moderate', 'High', 'Very high', 'Extreme']
export const fdrLabel = (v: number | null) => (v == null ? 'n/a' : (FDR_LABEL[v] ?? `class ${v}`))

export function ffmcClass(ffmc: number | null): { label: string; color: string } {
  if (ffmc == null) return { label: 'n/a', color: '#64748b' }
  if (ffmc < 74) return { label: 'Low', color: '#3b82f6' }
  if (ffmc < 84) return { label: 'Moderate', color: '#22c55e' }
  if (ffmc < 88) return { label: 'High', color: '#eab308' }
  if (ffmc < 91) return { label: 'Very high', color: '#f97316' }
  return { label: 'Extreme', color: '#ef4444' }
}

/** 0–1 multiplier for scan priority: fine fuel moisture 70 → 0, 95 → 1 (CWFIS FFMC scale). */
export function drynessFactor(ffmc: number | null): number {
  if (ffmc == null) return 0.5
  return Math.min(1, Math.max(0, (ffmc - 70) / 25))
}

async function featureInfo(layer: string, lon: number, lat: number, signal: AbortSignal): Promise<{ v: Record<string, number>; ts?: string }> {
  const d = 0.05
  const u = new URL(CWFIS_WMS)
  const p = u.searchParams
  p.set('service', 'WMS'); p.set('version', '1.1.1'); p.set('request', 'GetFeatureInfo')
  p.set('layers', layer); p.set('query_layers', layer); p.set('styles', ''); p.set('srs', 'EPSG:4326')
  p.set('bbox', `${lon - d},${lat - d},${lon + d},${lat + d}`); p.set('width', '101'); p.set('height', '101'); p.set('x', '50'); p.set('y', '50')
  p.set('info_format', 'application/json')
  const r = await fetch(u, { signal })
  if (!r.ok) throw new Error(`${layer} ${r.status}`)
  const j = (await r.json()) as { features?: { properties: Record<string, number> }[]; timeStamp?: string }
  return { v: j.features?.[0]?.properties ?? {}, ts: j.timeStamp }
}

/** Live CWFIS fire-weather readings at a point (daily SCRIBE forecast grid). */
export function useDryness(lon: number, lat: number) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'unavailable'; data: Dryness | null }>({ status: 'loading', data: null })
  useEffect(() => {
    const c = new AbortController()
    Promise.all((['ffmc_current', 'fwi_current', 'fdr_current', 'dc_current'] as const).map((l) => featureInfo(l, lon, lat, c.signal)))
      .then(([a, b, d, e]) =>
        setState({
          status: 'ok',
          data: { ffmc: a.v.FFMC ?? null, fwi: b.v.FWI ?? null, fdr: d.v.FDR ?? null, dc: e.v.DC ?? null, date: (a.ts ?? new Date().toISOString()).slice(0, 10) },
        }),
      )
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setState({ status: 'unavailable', data: null })
      })
    return () => c.abort()
  }, [lon, lat])
  return state
}

export interface ImageryInfo {
  provider: string
  date: string | null
  resolution_m: number | null
}

/** Acquisition metadata of the Esri World Imagery tile under a point (so the date we show is real). */
export function useImageryInfo(lon: number, lat: number, zoom: number) {
  const [info, setInfo] = useState<ImageryInfo | null>(null)
  const key = `${lon.toFixed(2)},${lat.toFixed(2)},${Math.round(zoom)}`
  useEffect(() => {
    const [lon, lat, zoom] = key.split(',').map(Number)
    const c = new AbortController()
    const u = new URL(`${ESRI_IMAGERY}/4/query`)
    u.searchParams.set('geometry', `${lon},${lat}`); u.searchParams.set('geometryType', 'esriGeometryPoint'); u.searchParams.set('inSR', '4326')
    u.searchParams.set('outFields', 'SRC_DATE2,NICE_NAME,SRC_RES,NICE_DESC,MinMapLevel,MaxMapLevel'); u.searchParams.set('returnGeometry', 'false'); u.searchParams.set('f', 'json')
    fetch(u, { signal: c.signal })
      .then((r) => r.json())
      .then((j: { features?: { attributes: { SRC_DATE2: number | null; NICE_NAME: string; SRC_RES: number; NICE_DESC: string; MinMapLevel: number; MaxMapLevel: number } }[] }) => {
        const z = Math.round(zoom)
        const f = j.features?.find((x) => z >= x.attributes.MinMapLevel && z <= x.attributes.MaxMapLevel) ?? j.features?.at(-1)
        if (!f) return
        const a = f.attributes
        setInfo({ provider: `${a.NICE_DESC} ${a.NICE_NAME}`.trim(), date: a.SRC_DATE2 ? new Date(a.SRC_DATE2).toISOString().slice(0, 10) : null, resolution_m: a.SRC_RES ?? null })
      })
      .catch(() => {})
    return () => c.abort()
  }, [key])
  return info
}
