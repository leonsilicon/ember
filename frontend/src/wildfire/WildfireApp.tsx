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
import { LayerControls, type Basemap } from './LayerControls'
import { drynessFactor, fdrLabel, ffmcClass, useDryness, useImageryInfo } from './live'
import {
  BASEMAP,
  BUILDINGS_SOURCE,
  DRYNESS_SOURCE,
  HAZARD_SOURCE,
  L,
  LEAFOFF_SOURCE,
  NO_SELECTION,
  SATELLITE_SOURCE,
  SELECTED_SOURCE,
  basemapLayerIds,
  buildingLayers,
  drynessLayer,
  drynessSource,
  firstSymbolLayer,
  hazardLayer,
  hazardOpacity,
  leafoffLayer,
  satelliteLayer,
  satelliteSource,
  selectedLayers,
} from './mapLayers'
import { SearchBar } from './SearchBar'
import { normalizeProps, type BuildingProps, type Coverage, type ListFilter } from './types'
import { BTN, MICRO, PANEL } from './ui'
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

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function WildfireApp() {
  const { data, error } = useWildfireData()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const basemapIdsRef = useRef<string[]>([])
  const [ready, setReady] = useState(false)
  const [basemap, setBasemap] = useState<Basemap>('satellite')
  const [showHazard, setShowHazard] = useState(true)
  const [showBuildings, setShowBuildings] = useState(true)
  const [showLeafoff, setShowLeafoff] = useState(false)
  const [showDryness, setShowDryness] = useState(false)
  const [opacity, setOpacity] = useState(0.55)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [visible, setVisible] = useState<BuildingProps[]>([])
  const [view, setView] = useState({ lon: -79.2, lat: 45.33, zoom: 0 })
  const [filter, setFilter] = useState<ListFilter>('all')
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' })
  const [sheetOpen, setSheetOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const openSheet = useCallback(() => {
    setSheetOpen(true)
    setLayersOpen(false)
  }, [])
  const now = useClock()

  // On phones the open sheet covers the lower 60% of the map; pad the camera so the selected
  // building / search pin stays in the visible part.
  const tapEaseRef = useRef(false)
  const sheetOpenRef = useRef(false)
  useEffect(() => {
    sheetOpenRef.current = sheetOpen
    const map = mapRef.current
    if (!map || !ready) return
    if (tapEaseRef.current) {
      // the tap handler already started an easeTo with centre + padding; don't cancel it
      tapEaseRef.current = false
      return
    }
    const mobile = window.matchMedia('(max-width: 767px)').matches
    map.easeTo({ padding: { top: 0, left: 0, right: 0, bottom: mobile && sheetOpen ? Math.round(window.innerHeight * 0.6) : 0 }, duration: 300 })
  }, [sheetOpen, ready])

  const bias = useMemo(() => {
    if (!data) return { lon: -79.2, lat: 45.33 }
    const [w, s, e, n] = data.coverage.bbox
    return { lon: (w + e) / 2, lat: (s + n) / 2 }
  }, [data])
  const dryness = useDryness(bias.lon, bias.lat)
  const dry = drynessFactor(dryness.data?.ffmc ?? null)
  const imagery = useImageryInfo(view.lon, view.lat, view.zoom)

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
      const style = map.getStyle()
      const before = firstSymbolLayer(style.layers)
      basemapIdsRef.current = basemapLayerIds(style)
      // imagery sits just above the style's background so labels stay on top
      const aboveBackground = style.layers.find((l) => l.type !== 'background')?.id
      map.addSource(SATELLITE_SOURCE, satelliteSource())
      map.addLayer(satelliteLayer(), aboveBackground)
      map.addSource(DRYNESS_SOURCE, drynessSource())
      map.addLayer(drynessLayer(), before)
      map.addSource(HAZARD_SOURCE, { type: 'vector', url: `pmtiles://${abs(coverage.tiles.hazard)}` })
      map.addSource(BUILDINGS_SOURCE, { type: 'vector', url: `pmtiles://${abs(coverage.tiles.buildings)}` })
      map.addSource(SELECTED_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('wf-coverage', { type: 'geojson', data: coverage.coverage })
      map.addLayer(hazardLayer(categories, 0.55, true), before)
      if (coverage.tiles.leafoff) {
        map.addSource(LEAFOFF_SOURCE, { type: 'vector', url: `pmtiles://${abs(coverage.tiles.leafoff)}` })
        map.addLayer(leafoffLayer(), before)
      }
      for (const l of buildingLayers()) map.addLayer(l, before)
      map.addLayer(
        { id: 'wf-coverage-line', type: 'line', source: 'wf-coverage', paint: { 'line-color': '#67e8f9', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': 0.6 } },
        before,
      )
      for (const l of selectedLayers()) map.addLayer(l, before)
      setReady(true)
    })

    map.on('click', L.buildingsFill, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      const props = normalizeProps(f.properties, f.id)
      setSearch({ kind: 'idle' })
      setSelected({ props, geometry: f.geometry })
      if (window.matchMedia('(max-width: 767px)').matches) {
        // keep the tapped footprint in the strip of map left above the sheet; flag so the
        // sheet-padding effect doesn't start a competing easeTo that cancels this one
        tapEaseRef.current = !sheetOpenRef.current // the effect only re-runs when the sheet was closed
        map.easeTo({ center: [props.lon, props.lat], padding: { top: 0, left: 0, right: 0, bottom: Math.round(window.innerHeight * 0.6) }, duration: 350 })
      }
      openSheet()
    })
    map.on('mouseenter', L.buildingsFill, () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', L.buildingsFill, () => (map.getCanvas().style.cursor = ''))

    const refresh = () => {
      const c = map.getCenter()
      setView({ lon: c.lng, lat: c.lat, zoom: map.getZoom() })
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
    const sat = basemap === 'satellite'
    map.setLayoutProperty(L.satellite, 'visibility', sat ? 'visible' : 'none')
    for (const id of basemapIdsRef.current) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', sat ? 'none' : 'visible')
    map.setLayoutProperty(L.hazardFill, 'visibility', showHazard ? 'visible' : 'none')
    map.setPaintProperty(L.hazardFill, 'fill-opacity', hazardOpacity(opacity, sat))
    for (const id of [L.buildingsFill, L.buildingsLine]) map.setLayoutProperty(id, 'visibility', showBuildings ? 'visible' : 'none')
    if (map.getLayer(L.leafoff)) map.setLayoutProperty(L.leafoff, 'visibility', showLeafoff ? 'visible' : 'none')
    map.setLayoutProperty(L.dryness, 'visibility', showDryness ? 'visible' : 'none')
  }, [ready, basemap, showHazard, showBuildings, showLeafoff, showDryness, opacity])

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
    markerRef.current = new Marker({ color: '#22d3ee' }).setLngLat([lon, lat]).addTo(map)
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

  const pickFromList = useCallback(
    (b: BuildingProps) => {
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
    },
    [openSheet],
  )

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
        <div className={`m-auto max-w-sm p-6 text-center ${PANEL}`}>
          <p className="font-semibold text-slate-100">Hazard data unavailable</p>
          <p className="mt-1 text-sm text-slate-400">Couldn't load the pilot dataset ({error}). Run <code>data/wildfire/pipeline.py</code> to generate it.</p>
        </div>
      </Shell>
    )
  }

  const panelBody = (() => {
    if (!data) return null
    if (selected) return <BuildingPanel b={selected.props} categories={data.categories} coverage={data.coverage} dryness={dryness} drynessFactor={dry} onClose={() => setSelected(null)} />
    if (search.kind === 'choose')
      return (
        <div className="p-4">
          <p className={MICRO}>Which building?</p>
          <p className="mt-1 text-sm text-slate-300">
            The address point for <span className="font-medium text-slate-100">{search.hit.label}</span> doesn't land on a single footprint. Pick the right one:
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
                  className="flex w-full items-center justify-between rounded-xl border border-white/10 px-3 py-2 text-left text-sm hover:bg-white/5"
                >
                  <span>
                    <span className="font-mono text-slate-400">#{c.props.fid}</span> · {Math.round(c.props.area_m2)} m²
                  </span>
                  <span className="font-mono text-xs text-slate-500">{Math.round(distM(search.hit, c.props))} m from pin</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )
    if (search.kind === 'missing')
      return (
        <StateCard title="No building footprint here">
          We don't have a footprint within 80 m of <span className="font-medium text-slate-100">{search.hit.label}</span>. Building data misses some structures (Microsoft's
          Canadian set reports ~72% recall). Click any nearby outline instead, or zoom to check the hazard colours under the pin.
        </StateCard>
      )
    if (search.kind === 'outside')
      return (
        <StateCard title="Outside the pilot area">
          <span className="font-medium text-slate-100">{search.hit.label}</span> is outside {data.coverage.area_name}, the only area with hazard screening so far. The dashed
          outline on the map marks the covered area.
        </StateCard>
      )
    if (search.kind === 'locating') return <StateCard title="Locating…">Flying to the address and finding its footprint.</StateCard>
    return <VisibleList items={visible} filter={filter} dryness={dry} onFilter={setFilter} onPick={pickFromList} zoomedOut={view.zoom < LIST_MIN_ZOOM} />
  })()

  const flagged = visible.filter((b) => b.hazard_overlap || b.hazard_within_30m).length
  const ffmc = ffmcClass(dryness.data?.ffmc ?? null)
  const utc = now.toISOString().slice(0, 19).replace('T', ' ')

  const layerControls = data && (
    <LayerControls
      categories={data.categories}
      coverage={data.coverage}
      basemap={basemap}
      showHazard={showHazard}
      showBuildings={showBuildings}
      showLeafoff={showLeafoff}
      showDryness={showDryness}
      opacity={opacity}
      onBasemap={setBasemap}
      onHazard={setShowHazard}
      onBuildings={setShowBuildings}
      onLeafoff={setShowLeafoff}
      onDryness={setShowDryness}
      onOpacity={setOpacity}
    />
  )

  return (
    <Shell>
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {!ready && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <div className={`flex items-center gap-3 px-5 py-3 ${PANEL}`}>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />
            <span className="text-sm text-slate-200">{data ? 'Loading map…' : 'Loading hazard data…'}</span>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-3 p-3 md:right-[412px] md:p-4">
        <div className="flex items-start gap-3">
          <a href="#/" className={`pointer-events-auto hidden shrink-0 px-3 py-2 md:block ${PANEL}`}>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className={`h-2 w-2 rounded-full ${dryness.status === 'ok' ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : dryness.status === 'loading' ? 'bg-amber-400' : 'bg-rose-500'}`} />
              Wildfire ops
            </span>
            <span className="block text-[11px] text-slate-400">{data?.coverage.area_name ?? '…'} · pilot</span>
          </a>
          <SearchBar bias={bias} onPick={onPickHit} />
          <button type="button" onClick={searchThisArea} className={`pointer-events-auto ml-auto hidden shrink-0 px-3 py-2 text-sm font-medium md:block ${PANEL}`}>
            Search this area
          </button>
        </div>
        <div className="hidden md:flex md:items-start md:gap-3">
          {layerControls}
          <div className={`pointer-events-auto px-3 py-2 ${PANEL}`}>
            <p className={MICRO}>Live · {utc} UTC</p>
            <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 font-mono text-xs tabular-nums">
              <dt className="text-slate-500">Fine fuel</dt>
              <dd style={{ color: ffmc.color }}>{dryness.data?.ffmc != null ? `${dryness.data.ffmc.toFixed(0)} · ${ffmc.label}` : dryness.status === 'loading' ? '…' : 'offline'}</dd>
              <dt className="text-slate-500">FWI</dt>
              <dd className="text-slate-200">{dryness.data?.fwi != null ? dryness.data.fwi.toFixed(1) : '—'}</dd>
              <dt className="text-slate-500">Danger</dt>
              <dd className="text-slate-200">{fdrLabel(dryness.data?.fdr ?? null)}</dd>
              <dt className="text-slate-500">Weather</dt>
              <dd className="text-slate-400">CWFIS {dryness.data?.date ?? ''}</dd>
              <dt className="text-slate-500">Imagery</dt>
              <dd className="text-slate-400">{imagery ? `${imagery.date ?? 'undated'}${imagery.resolution_m ? ` · ${imagery.resolution_m} m` : ''}` : '—'}</dd>
              <dt className="text-slate-500">Hazard</dt>
              <dd className="text-slate-400">MNRF {data?.categories.source.date ?? ''}</dd>
            </dl>
          </div>
        </div>
      </div>

      {/* desktop side panel */}
      <aside className={`absolute top-4 right-4 bottom-4 z-10 hidden w-[380px] flex-col overflow-hidden md:flex ${PANEL}`}>{panelBody}</aside>

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
            className={`pointer-events-auto ${BTN}`}
          >
            Layers
          </button>
          {layersOpen && <div className="pointer-events-auto absolute bottom-10 left-3 z-20 max-h-[70vh] overflow-y-auto rounded-2xl">{layerControls}</div>}
          <button type="button" onClick={searchThisArea} className={`pointer-events-auto ${BTN}`}>
            Search this area
          </button>
        </div>
        <div className={`rounded-t-2xl border-t border-white/10 bg-slate-950/95 text-slate-100 shadow-[0_-8px_30px_rgba(0,0,0,0.5)] backdrop-blur-md transition-[height] ${sheetOpen ? 'h-[60vh]' : 'h-14'}`}>
          <button type="button" onClick={() => (sheetOpen ? setSheetOpen(false) : openSheet())} className="flex h-14 w-full items-center justify-between px-4" aria-expanded={sheetOpen}>
            <span className="text-sm font-medium">
              {selected ? `Building #${selected.props.fid}` : view.zoom < LIST_MIN_ZOOM ? 'Zoom in to list buildings' : `${flagged} flagged · ${visible.length} visible`}
            </span>
            <span className="flex items-center gap-3">
              <span className="font-mono text-xs" style={{ color: ffmc.color }}>{dryness.data?.ffmc != null ? `FFMC ${dryness.data.ffmc.toFixed(0)}` : ''}</span>
              <span className="h-1 w-10 rounded-full bg-slate-600" />
            </span>
          </button>
          {sheetOpen && <div className="h-[calc(60vh-3.5rem)] overflow-hidden">{panelBody}</div>}
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="wildfire relative flex h-full w-full overflow-hidden bg-slate-950 text-slate-100 select-text">{children}</div>
}

function StateCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4">
      <p className="text-sm font-semibold text-slate-100">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-400">{children}</p>
    </div>
  )
}
