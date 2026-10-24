import type { Geometry } from 'geojson'
import {
  Map as MLMap,
  Marker,
  NavigationControl,
  ScaleControl,
  addProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
  type MapLayerMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { Protocol } from 'pmtiles'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BuildingPanel } from './BuildingPanel'
import type { GeocodeHit } from './geocode'
import { LayerControls } from './LayerControls'
import {
  BASEMAP,
  BUILDINGS_SOURCE,
  HAZARD_SOURCE,
  L,
  NO_SELECTION,
  SELECTED_SOURCE,
  buildingLayers,
  firstSymbolLayer,
  hazardLayer,
  hazardOpacity,
  selectedLayers,
} from './mapLayers'
import { SearchBar } from './SearchBar'
import { normalizeProps, type BuildingProps, type Coverage, type ListFilter } from './types'
import { DATA_BASE, useWildfireData } from './useWildfireData'
import { VisibleList } from './VisibleList'

setWorkerUrl(maplibreWorkerUrl)
const protocol = new Protocol()
addProtocol('pmtiles', protocol.tile)

const LIST_MIN_ZOOM = 13

type Selected = { props: BuildingProps; geometry: Geometry }
type SearchState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'outside'; hit: GeocodeHit }
  | { kind: 'choose'; hit: GeocodeHit; candidates: Selected[] }
  | { kind: 'missing'; hit: GeocodeHit }

function inBbox(lon: number, lat: number, [w, s, e, n]: Coverage['bbox']) {
  return lon >= w && lon <= e && lat >= s && lat <= n
}

function dedupe(features: MapGeoJSONFeature[]): Selected[] {
  const seen = new Map<number, Selected>()
  for (const f of features) {
    const p = normalizeProps(f.properties, f.id)
    if (!seen.has(p.fid)) seen.set(p.fid, { props: p, geometry: f.geometry })
  }
  return [...seen.values()]
}

function distM(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  const k = Math.PI / 180
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k)
  const y = (b.lat - a.lat) * k
  return Math.sqrt(x * x + y * y) * 6371000
}

export default function WildfireApp() {
  const { data, error } = useWildfireData()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const [ready, setReady] = useState(false)
  const [showHazard, setShowHazard] = useState(true)
  const [showBuildings, setShowBuildings] = useState(true)
  const [opacity, setOpacity] = useState(0.6)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [visible, setVisible] = useState<BuildingProps[]>([])
  const [zoom, setZoom] = useState(0)
  const [filter, setFilter] = useState<ListFilter>('all')
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' })
  const [sheetOpen, setSheetOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const openSheet = useCallback(() => {
    setSheetOpen(true)
    setLayersOpen(false)
  }, [])

  // On phones the open sheet covers the lower 60% of the map; pad the camera so the selected
  // building / search pin stays in the visible part.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const mobile = window.matchMedia('(max-width: 767px)').matches
    map.easeTo({ padding: { top: 0, left: 0, right: 0, bottom: mobile && sheetOpen ? Math.round(window.innerHeight * 0.6) : 0 }, duration: 300 })
  }, [sheetOpen, ready])

  const bias = useMemo(() => {
    if (!data) return { lon: -79.2, lat: 45.33 }
    const [w, s, e, n] = data.coverage.bbox
    return { lon: (w + e) / 2, lat: (s + n) / 2 }
  }, [data])

  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return
    const { coverage, categories } = data
    const map = new MLMap({
      container: containerRef.current,
      style: BASEMAP,
      bounds: coverage.bbox as LngLatBoundsLike,
      fitBoundsOptions: { padding: 40 },
      maxZoom: 19,
      attributionControl: { compact: true },
    })
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
    mapRef.current = map

    const abs = (p: string) => new URL(`${DATA_BASE}${p}`, window.location.href).href

    map.on('load', () => {
      const before = firstSymbolLayer(map.getStyle().layers)
      map.addSource(HAZARD_SOURCE, { type: 'vector', url: `pmtiles://${abs(coverage.tiles.hazard)}` })
      map.addSource(BUILDINGS_SOURCE, { type: 'vector', url: `pmtiles://${abs(coverage.tiles.buildings)}` })
      map.addSource(SELECTED_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('wf-coverage', { type: 'geojson', data: coverage.coverage })
      map.addLayer(hazardLayer(categories, 0.6), before)
      for (const l of buildingLayers()) map.addLayer(l, before)
      map.addLayer(
        { id: 'wf-coverage-line', type: 'line', source: 'wf-coverage', paint: { 'line-color': '#0f172a', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': 0.5 } },
        before,
      )
      for (const l of selectedLayers()) map.addLayer(l, before)
      setReady(true)
    })

    map.on('click', L.buildingsFill, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      setSearch({ kind: 'idle' })
      setSelected({ props: normalizeProps(f.properties, f.id), geometry: f.geometry })
      openSheet()
    })
    map.on('mouseenter', L.buildingsFill, () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', L.buildingsFill, () => (map.getCanvas().style.cursor = ''))

    const refresh = () => {
      setZoom(map.getZoom())
      if (map.getZoom() < LIST_MIN_ZOOM || !map.getLayer(L.buildingsFill)) {
        setVisible([])
        return
      }
      setVisible(dedupe(map.queryRenderedFeatures({ layers: [L.buildingsFill] })).map((s) => s.props))
    }
    map.on('idle', refresh)

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [data, openSheet])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    map.setLayoutProperty(L.hazardFill, 'visibility', showHazard ? 'visible' : 'none')
    map.setPaintProperty(L.hazardFill, 'fill-opacity', hazardOpacity(opacity))
    for (const id of [L.buildingsFill, L.buildingsLine]) map.setLayoutProperty(id, 'visibility', showBuildings ? 'visible' : 'none')
  }, [ready, showHazard, showBuildings, opacity])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const src = map.getSource(SELECTED_SOURCE) as GeoJSONSource | undefined
    src?.setData(selected ? { type: 'Feature', geometry: selected.geometry, properties: {} } : { type: 'FeatureCollection', features: [] })
    map.setFilter(L.selectedRing, selected ? ['==', ['id'], selected.props.fid] : NO_SELECTION)
  }, [ready, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const placeMarker = useCallback((lon: number, lat: number) => {
    const map = mapRef.current
    if (!map) return
    markerRef.current?.remove()
    markerRef.current = new Marker({ color: '#0ea5e9' }).setLngLat([lon, lat]).addTo(map)
  }, [])

  const onPickHit = useCallback(
    (hit: GeocodeHit) => {
      const map = mapRef.current
      if (!map || !data) return
      setSelected(null)
      placeMarker(hit.lon, hit.lat)
      if (!inBbox(hit.lon, hit.lat, data.coverage.bbox)) {
        setSearch({ kind: 'outside', hit })
        map.flyTo({ center: [hit.lon, hit.lat], zoom: Math.max(map.getZoom(), 12), duration: 1200 })
        return
      }
      setSearch({ kind: 'locating' })
      map.flyTo({ center: [hit.lon, hit.lat], zoom: 17.5, duration: 1400 })
      map.once('idle', () => {
        const pt = map.project([hit.lon, hit.lat])
        const exact = dedupe(map.queryRenderedFeatures(pt, { layers: [L.buildingsFill] }))
        if (exact.length === 1) {
          setSelected(exact[0])
          openSheet()
          setSearch({ kind: 'idle' })
          return
        }
        // pixel box wide enough to cover the 80 m radius at the current zoom (plus footprint extent)
        const mpp = (40075016.686 * Math.cos((hit.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom())
        const r = Math.ceil(120 / mpp)
        const near = dedupe(map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers: [L.buildingsFill] }))
          .map((s) => ({ s, d: distM(hit, s.props) }))
          .filter((x) => x.d <= 80)
          .sort((a, b) => a.d - b.d)
          .slice(0, 6)
          .map((x) => x.s)
        if (near.length === 0) setSearch({ kind: 'missing', hit })
        else {
          setSearch({ kind: 'choose', hit, candidates: near })
          openSheet()
        }
      })
    },
    [data, placeMarker, openSheet],
  )

  const pickFromList = useCallback((b: BuildingProps) => {
    const map = mapRef.current
    if (!map) return
    setSearch({ kind: 'idle' })
    map.flyTo({ center: [b.lon, b.lat], zoom: Math.max(map.getZoom(), 17), duration: 800 })
    map.once('idle', () => {
      const pt = map.project([b.lon, b.lat])
      const f = dedupe(map.queryRenderedFeatures([[pt.x - 2, pt.y - 2], [pt.x + 2, pt.y + 2]], { layers: [L.buildingsFill] })).find(
        (s) => s.props.fid === b.fid,
      )
      setSelected(f ?? null)
      openSheet()
    })
  }, [openSheet])

  const searchThisArea = () => {
    const map = mapRef.current
    if (!map) return
    setSelected(null)
    setSearch({ kind: 'idle' })
    openSheet()
    if (map.getZoom() < LIST_MIN_ZOOM) map.zoomTo(LIST_MIN_ZOOM + 0.5, { duration: 600 })
    else map.fire('idle')
  }

  if (error) {
    return (
      <Shell>
        <div className="m-auto max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-lg">
          <p className="font-semibold text-slate-900">Hazard data unavailable</p>
          <p className="mt-1 text-sm text-slate-600">Couldn't load the pilot dataset ({error}). Run <code>data/wildfire/pipeline.py</code> to generate it.</p>
        </div>
      </Shell>
    )
  }

  const panelBody = (() => {
    if (!data) return null
    if (selected) return <BuildingPanel b={selected.props} categories={data.categories} onClose={() => setSelected(null)} />
    if (search.kind === 'choose')
      return (
        <div className="p-4">
          <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Which building?</p>
          <p className="mt-1 text-sm text-slate-700">
            The address point for <span className="font-medium">{search.hit.label}</span> doesn't land on a single footprint. Pick the right one:
          </p>
          <ul className="mt-3 space-y-1">
            {search.candidates.map((c) => (
              <li key={c.props.fid}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(c)
                    setSearch({ kind: 'idle' })
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span>
                    #{c.props.fid} · {Math.round(c.props.area_m2)} m²
                  </span>
                  <span className="text-xs text-slate-500">{Math.round(distM(search.hit, c.props))} m from pin</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )
    if (search.kind === 'missing')
      return (
        <StateCard title="No building footprint here">
          We don't have a footprint within 80 m of <span className="font-medium">{search.hit.label}</span>. Building data misses some structures (Microsoft's
          Canadian set reports ~72% recall). Click any nearby outline instead, or zoom to check the hazard colours under the pin.
        </StateCard>
      )
    if (search.kind === 'outside')
      return (
        <StateCard title="Outside the pilot area">
          <span className="font-medium">{search.hit.label}</span> is outside {data.coverage.area_name}, the only area with hazard screening so far. The dashed
          outline on the map marks the covered area.
        </StateCard>
      )
    if (search.kind === 'locating') return <StateCard title="Locating…">Flying to the address and finding its footprint.</StateCard>
    return <VisibleList items={visible} filter={filter} onFilter={setFilter} onPick={pickFromList} zoomedOut={zoom < LIST_MIN_ZOOM} />
  })()

  const flagged = visible.filter((b) => b.hazard_overlap || b.hazard_within_30m).length

  return (
    <Shell>
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {!ready && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-100/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-2xl bg-white px-5 py-3 shadow-lg">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
            <span className="text-sm text-slate-700">{data ? 'Loading map…' : 'Loading hazard data…'}</span>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-3 p-3 md:right-[412px] md:p-4">
        <div className="flex items-start gap-3">
          <a href="#/" className="pointer-events-auto hidden rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-sm font-semibold text-slate-800 shadow-lg shadow-slate-900/10 backdrop-blur md:block">
            Wildfire hazard
            <span className="block text-[11px] font-normal text-slate-500">{data?.coverage.area_name ?? '…'} · pilot</span>
          </a>
          <SearchBar bias={bias} onPick={onPickHit} />
          <button
            type="button"
            onClick={searchThisArea}
            className="pointer-events-auto ml-auto hidden rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-sm font-medium text-slate-800 shadow-lg shadow-slate-900/10 backdrop-blur hover:bg-white md:block"
          >
            Search this area
          </button>
        </div>
        <div className="hidden md:block">{data && <LayerControls categories={data.categories} showHazard={showHazard} showBuildings={showBuildings} opacity={opacity} onHazard={setShowHazard} onBuildings={setShowBuildings} onOpacity={setOpacity} />}</div>
      </div>

      {/* desktop side panel */}
      <aside className="absolute top-4 right-4 bottom-4 z-10 hidden w-[380px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-xl shadow-slate-900/10 backdrop-blur md:flex">
        {panelBody}
      </aside>

      {/* mobile: layers + bottom sheet */}
      <div className="absolute bottom-0 inset-x-0 z-10 md:hidden">
        <div className="pointer-events-none relative mb-2 flex items-end justify-between px-3">
          <button
            type="button"
            onClick={() => {
              setLayersOpen((o) => !o)
              setSheetOpen(false)
            }}
            aria-expanded={layersOpen}
            className="pointer-events-auto rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-lg"
          >
            Layers
          </button>
          {layersOpen && data && (
            <div className="pointer-events-auto absolute bottom-10 left-3 z-20 max-h-[70vh] overflow-y-auto rounded-2xl bg-white">
              <LayerControls categories={data.categories} showHazard={showHazard} showBuildings={showBuildings} opacity={opacity} onHazard={setShowHazard} onBuildings={setShowBuildings} onOpacity={setOpacity} />
            </div>
          )}
          <button type="button" onClick={searchThisArea} className="pointer-events-auto rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-lg">
            Search this area
          </button>
        </div>
        <div className={`rounded-t-2xl border-t border-slate-200 bg-white shadow-[0_-8px_30px_rgba(15,23,42,0.12)] transition-[height] ${sheetOpen ? 'h-[60vh]' : 'h-14'}`}>
          <button type="button" onClick={() => (sheetOpen ? setSheetOpen(false) : openSheet())} className="flex h-14 w-full items-center justify-between px-4" aria-expanded={sheetOpen}>
            <span className="text-sm font-medium text-slate-800">
              {selected ? `Building #${selected.props.fid}` : zoom < LIST_MIN_ZOOM ? 'Zoom in to list buildings' : `${flagged} flagged · ${visible.length} visible`}
            </span>
            <span className="h-1 w-10 rounded-full bg-slate-300" />
          </button>
          {sheetOpen && <div className="h-[calc(60vh-3.5rem)] overflow-hidden">{panelBody}</div>}
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="wildfire relative flex h-full w-full overflow-hidden bg-slate-100 text-slate-900 select-text">{children}</div>
}

function StateCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-600">{children}</p>
    </div>
  )
}
