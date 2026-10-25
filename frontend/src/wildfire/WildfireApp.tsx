import { Button, Checkbox, HTMLSelect, Spinner, Tag } from '@blueprintjs/core'
import { Flame, Geolocation as Locate, Home, Layers, Satellite, Tree } from '@blueprintjs/icons'
import {
  Map as MLMap,
  NavigationControl,
  ScaleControl,
  addProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { TopBar } from '../rover/ui/Shell'
import { usePlaceName, type GeocodeHit } from './geocode'
import { drynessFactor, ffmcClass, useDryness, useImageryInfo, useWind, useWindField } from './live'
import {
  BASEMAP,
  BREAKS_SOURCE,
  BUILDINGS_SOURCE,
  DENSITY_POINTS_SOURCE,
  DENSITY_SOURCE,
  FLAME_IMAGE,
  ISO_SOURCE,
  L,
  NO_SELECTION,
  SATELLITE_SOURCE,
  SUGGEST_SOURCE,
  ZONE_ORANGE,
  ZONE_POINTS_SOURCE,
  ZONES_SOURCE,
  breaksLayer,
  buildingLayers,
  densityLayers,
  firstSymbolLayer,
  flameImage,
  isochroneLayers,
  restyleBuildings,
  satelliteLayer,
  satelliteSource,
  selectedLayers,
  suggestLayer,
  zoneIconLayer,
  zoneLayers,
} from './mapLayers'
import { DensityTab, HomeTab, OverviewTab, SimTab, ZoneTab } from './OpsPanel'
import { SearchBar } from './SearchBar'
import type { FbpInputs } from './sim/fbp'
import { FireLayer } from './sim/FireLayer'
import { cellOf, gridToLngLat } from './sim/grid'
import { Smoke } from './sim/Smoke'
import { evacuationOrder, waterEdge, type Suggestion } from './sim/suggest'
import { HORIZON_MIN, ISOCHRONES, NO_ACTIONS, applySuggestion as withSuggestion, ignitionKey, lowerBound, useSimulation, type FuelBreak, type Ignition, type Polyline, type SimActions } from './sim/useSimulation'
import { Timeline } from './Timeline'
import { bandOf, drynessMultiplier, riskOf, type BuildingRow } from './types'
import { useAreas, useWildfireData } from './useWildfireData'
import { WindLayer } from './WindLayer'

// Under Turbopack, maplibre's own `import.meta.url` is not an http(s) URL, so its default worker URL
// comes out empty and every map fails with "Worker failed to load"; point it at the bundled worker.
setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href)
const protocol = new Protocol()
addProtocol('pmtiles', protocol.tile)

type Tab = 'overview' | 'zone' | 'density' | 'home' | 'sim'
type LayerKey = 'zones' | 'homes' | 'density' | 'wind'
/** fuel categories a fire can be started in */
const BURNABLE = new Set(['extreme', 'high', 'pine_eval', 'moderate', 'low'])
const DEFAULT_WEIGHTS = { fuel: 0.55, leafoff: 0.25, neighbours: 0.2 }

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

function distM(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  const x = ((b.lon - a.lon) * Math.PI * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))) / 180
  const y = ((b.lat - a.lat) * Math.PI) / 180
  return Math.sqrt(x * x + y * y) * 6371000
}

export default function WildfireApp() {
  const areas = useAreas()
  const [areaId, setAreaId] = useState<string | null>(null)
  const area = areas.find((a) => a.id === areaId) ?? areas[0] ?? null
  const { data, error } = useWildfireData(area?.base ?? null)
  const containerRef = useRef<HTMLDivElement>(null)
  const smokeCanvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const loadedMapRef = useRef<MLMap | null>(null) // the map whose style has loaded; `ready` can lag one render behind an area switch
  const fireRef = useRef<FireLayer | null>(null)
  const smokeRef = useRef<Smoke | null>(null)
  const basemapIdsRef = useRef<string[]>([])
  const [ready, setReady] = useState(false)
  const [satellite, setSatellite] = useState(true)
  const [tab, setTab] = useState<Tab>('overview')
  const [selectedZone, setSelectedZone] = useState<number | null>(null)
  const [selectedDensity, setSelectedDensity] = useState<number | null>(null)
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ zones: true, homes: true, density: false, wind: false })
  const [layersOpen, setLayersOpen] = useState(false)
  const windCanvasRef = useRef<HTMLCanvasElement>(null)
  const windRef = useRef<WindLayer | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [searchNote, setSearchNote] = useState<string | null>(null)
  const [view, setView] = useState({ lon: -79.15, lat: 45.33, zoom: 0 })
  const now = useClock()

  const centre = useMemo(() => {
    if (!data) return { lon: -79.15, lat: 45.33 }
    const [w, s, e, n] = data.coverage.bbox
    return { lon: (w + e) / 2, lat: (s + n) / 2 }
  }, [data])
  const dryness = useDryness(centre.lon, centre.lat)
  const dry = drynessFactor(dryness.data?.ffmc ?? null)
  const wind = useWind(centre.lon, centre.lat)
  const imagery = useImageryInfo(view.lon, view.lat, view.zoom)

  // ---- simulation state
  const buildings = useMemo(() => data?.buildings ?? [], [data])
  const byFid = useMemo(() => data?.byFid ?? new Map<number, BuildingRow>(), [data])
  const roads = useMemo(() => (data?.roads.features ?? []).map((f) => ({ line: f.geometry.coordinates as Polyline, name: f.properties.name })), [data])
  const sim = useSimulation(data?.grid ?? null, buildings, roads)
  const [weather, setWeather] = useState<FbpInputs | null>(null)
  const [actions, setActions] = useState<SimActions>(NO_ACTIONS)
  const [drawing, setDrawing] = useState<[number, number] | null | false>(false) // false = not drawing, null = waiting for 1st point
  const drawingRef = useRef(drawing)
  drawingRef.current = drawing
  const [igniting, setIgniting] = useState(false)
  const ignitingRef = useRef(igniting)
  ignitingRef.current = igniting
  const [mapNote, setMapNote] = useState<string | null>(null)
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => {})
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(15)
  const ignitedPtrRef = useRef(0)
  const prevIgnitedRef = useRef<number[]>([])

  const liveWeather = useMemo<FbpInputs>(
    () => ({ ffmc: dryness.data?.ffmc ?? 88, windKmh: wind.speedKmh, windFromDeg: wind.fromDeg, month: now.getMonth() + 1 }),
    [dryness.data?.ffmc, wind.speedKmh, wind.fromDeg, now],
  )
  const activeWeather = weather ?? liveWeather

  // ---- map
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return
    const { coverage } = data
    const map = new MLMap({
      container: containerRef.current,
      style: BASEMAP,
      bounds: coverage.bbox as LngLatBoundsLike,
      fitBoundsOptions: { padding: { top: 60, bottom: 60, left: 440, right: 60 } },
      maxZoom: 19,
      attributionControl: { compact: true },
    })
    map.addControl(new NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right')
    mapRef.current = map
    const abs = (p: string) => new URL(`${data.base}${p}`, window.location.href).href
    setReady(false)
    setSelected(null)
    setSelectedZone(null)
    setSelectedDensity(null)
    setTab('overview')

    map.on('load', () => {
      const style = map.getStyle()
      const before = firstSymbolLayer(style.layers)
      basemapIdsRef.current = style.layers.filter((l) => l.type !== 'symbol' && l.type !== 'background').map((l) => l.id)
      const aboveBackground = style.layers.find((l) => l.type !== 'background')?.id
      map.addSource(SATELLITE_SOURCE, satelliteSource())
      map.addLayer(satelliteLayer(), aboveBackground)
      map.addSource(BUILDINGS_SOURCE, { type: 'vector', url: `pmtiles://${abs(coverage.tiles.buildings)}` })
      map.addSource('wf-coverage', { type: 'geojson', data: coverage.coverage })
      map.addSource(ISO_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource(BREAKS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource(SUGGEST_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource(ZONES_SOURCE, { type: 'geojson', data: data.zones })
      map.addSource(ZONE_POINTS_SOURCE, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: data.zones.features.map((z) => ({
            type: 'Feature',
            id: z.properties.zid,
            properties: { zid: z.properties.zid, area_ha: z.properties.area_ha },
            geometry: { type: 'Point', coordinates: [z.properties.lon, z.properties.lat] },
          })),
        },
      })
      map.addSource(DENSITY_SOURCE, { type: 'geojson', data: data.density })
      map.addSource(DENSITY_POINTS_SOURCE, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: data.density.features.map((d) => ({
            type: 'Feature',
            id: d.properties.did,
            properties: { did: d.properties.did, homes: d.properties.homes },
            geometry: { type: 'Point', coordinates: [d.properties.lon, d.properties.lat] },
          })),
        },
      })
      const flame = flameImage()
      if (flame) map.addImage(FLAME_IMAGE, flame, { pixelRatio: 2 })
      for (const l of zoneLayers()) map.addLayer(l, before)
      for (const l of densityLayers()) map.addLayer(l, before)
      if (data.grid) {
        const fire = new FireLayer(data.grid)
        fireRef.current = fire
        map.addLayer(fire, before)
        if (smokeCanvasRef.current) smokeRef.current = new Smoke(smokeCanvasRef.current, map, data.grid)
      }
      for (const l of buildingLayers(drynessMultiplier(0.5))) map.addLayer(l, before)
      map.addLayer(
        { id: 'wf-coverage-line', type: 'line', source: 'wf-coverage', paint: { 'line-color': '#48aff0', 'line-width': 1, 'line-dasharray': [6, 4], 'line-opacity': 0.5 } },
        before,
      )
      map.addLayer(breaksLayer(), before)
      for (const l of isochroneLayers()) map.addLayer(l, before)
      for (const l of selectedLayers()) map.addLayer(l, before)
      map.addLayer(suggestLayer(), before)
      map.addLayer(zoneIconLayer())
      loadedMapRef.current = map
      setReady(true)
    })

    map.on('click', (e: MapMouseEvent) => clickRef.current(e))
    let hoverZone: number | null = null
    map.on('mousemove', (e: MapMouseEvent) => {
      if (drawingRef.current !== false || ignitingRef.current || !map.getLayer(L.zonesFill)) return
      const hits = map.queryRenderedFeatures(e.point, { layers: [L.buildingsFill, L.zonesFill, L.densityFill] })
      const zone = hits.find((f) => f.layer.id === L.zonesFill)
      const zid = zone && !hits.some((f) => f.layer.id === L.buildingsFill) ? Number(zone.id) : null
      if (zid !== hoverZone) {
        if (hoverZone != null) map.setFeatureState({ source: ZONES_SOURCE, id: hoverZone }, { hover: false })
        if (zid != null) map.setFeatureState({ source: ZONES_SOURCE, id: zid }, { hover: true })
        hoverZone = zid
      }
      map.getCanvas().style.cursor = hits.length ? 'pointer' : ''
    })
    map.on('move', () => {
      const c = map.getCenter()
      setView({ lon: c.lng, lat: c.lat, zoom: map.getZoom() })
    })
    map.on('resize', () => {
      smokeRef.current?.resize()
      windRef.current?.resize()
    })

    return () => {
      smokeRef.current?.destroy()
      smokeRef.current = null
      map.remove()
      mapRef.current = null
      loadedMapRef.current = null
    }
  }, [data])

  // today's dryness recolours every footprint
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    restyleBuildings(map, drynessMultiplier(dry))
  }, [ready, dry])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    map.setLayoutProperty(L.satellite, 'visibility', satellite ? 'visible' : 'none')
    for (const id of basemapIdsRef.current) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible')
  }, [ready, satellite])

  // selection highlight
  const prevSelected = useRef<number | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    const fs = (fid: number, v: boolean) => map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { selected: v })
    if (prevSelected.current != null) fs(prevSelected.current, false)
    if (selected != null) fs(selected, true)
    prevSelected.current = selected
    map.setFilter(L.selectedRing, selected != null ? ['==', ['id'], selected] : NO_SELECTION)
  }, [ready, selected])

  const prevZone = useRef<number | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    if (prevZone.current != null) map.setFeatureState({ source: ZONES_SOURCE, id: prevZone.current }, { selected: false })
    if (selectedZone != null) map.setFeatureState({ source: ZONES_SOURCE, id: selectedZone }, { selected: true })
    prevZone.current = selectedZone
  }, [ready, selectedZone])

  // a new area means a new grid: drop the previous area's run, what-if weather and actions
  const simReset = sim.reset
  useEffect(() => {
    simReset()
    setWeather(null)
    setActions(NO_ACTIONS)
    setDrawing(false)
    setIgniting(false)
  }, [data, simReset])

  const prevDensity = useRef<number | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    if (prevDensity.current != null) map.setFeatureState({ source: DENSITY_SOURCE, id: prevDensity.current }, { selected: false })
    if (selectedDensity != null) map.setFeatureState({ source: DENSITY_SOURCE, id: selectedDensity }, { selected: true })
    prevDensity.current = selectedDensity
  }, [ready, selectedDensity])

  // layer toggles
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    const vis = (ids: string[], on: boolean) => {
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    }
    vis([L.zonesGlow, L.zonesFill, L.zonesLine, L.zonesIcon], layers.zones)
    vis([L.buildingsGlow, L.buildingsFill, L.buildingsLine], layers.homes)
    vis([L.densityGlow, L.densityFill, L.densityLine, L.densityCount], layers.density)
  }, [ready, layers.zones, layers.homes, layers.density])

  const windField = useWindField(data?.coverage.bbox ?? null, layers.wind)
  useEffect(() => {
    const map = mapRef.current, canvas = windCanvasRef.current
    if (!ready || map !== loadedMapRef.current || !map || !canvas || !layers.wind) return
    const w = new WindLayer(canvas, map)
    windRef.current = w
    return () => {
      w.destroy()
      windRef.current = null
    }
  }, [ready, layers.wind])
  useEffect(() => {
    if (windRef.current) windRef.current.field = windField
  }, [windField, ready, layers.wind])

  // cleared homes highlight
  const prevCleared = useRef<Set<number>>(new Set())
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    for (const fid of prevCleared.current) if (!actions.cleared.has(fid)) map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { cleared: false })
    for (const fid of actions.cleared) map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { cleared: true })
    prevCleared.current = new Set(actions.cleared)
  }, [ready, actions.cleared])

  // fuel breaks on the map
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    const src = map.getSource(BREAKS_SOURCE) as GeoJSONSource | undefined
    const line = (coords: Polyline, kind: string) => ({ type: 'Feature' as const, properties: { kind }, geometry: { type: 'LineString' as const, coordinates: coords } })
    src?.setData({
      type: 'FeatureCollection',
      features: [...actions.breaks.map((b) => line(b, 'break')), ...actions.retardant.map((b) => line(b, 'retardant')), ...actions.burnouts.map((b) => line(b, 'burnout'))],
    })
    map.getCanvas().style.cursor = drawing !== false || igniting ? 'crosshair' : ''
  }, [ready, actions.breaks, actions.retardant, actions.burnouts, drawing, igniting])

  // suggested fuel breaks for the run on screen
  const suggestNow = sim.suggest && sim.suggest.forRun === sim.run ? sim.suggest : null
  useEffect(() => {
    const map = mapRef.current
    if (!ready || map !== loadedMapRef.current || !map) return
    const src = map.getSource(SUGGEST_SOURCE) as GeoJSONSource | undefined
    src?.setData({
      type: 'FeatureCollection',
      features: (suggestNow?.items ?? []).flatMap((s) => {
        const coords = s.brk ?? s.road
        return coords ? [{ type: 'Feature' as const, properties: { id: s.id, kind: s.kind }, geometry: { type: 'LineString' as const, coordinates: coords } }] : []
      }),
    })
  }, [ready, suggestNow])

  // re-run when actions or weather change while a simulation is live
  const runIgnition = sim.run?.ignition ?? null
  const runKey = runIgnition ? ignitionKey(runIgnition) : null
  const runIgnitionRef = useRef(runIgnition)
  runIgnitionRef.current = runIgnition
  useEffect(() => {
    if (runKey == null || !runIgnitionRef.current) return
    sim.simulate(runIgnitionRef.current, activeWeather, actions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, activeWeather, runKey])

  // push results into the map: arrival texture, isochrones, smoke source
  const ignitionSorted = useMemo(() => (sim.run ? [...sim.run.ignitedAt.entries()].sort((a, b) => a[1] - b[1]) : []), [sim.run])
  useEffect(() => {
    const map = mapRef.current
    const grid = data?.grid
    if (!ready || map !== loadedMapRef.current || !map || !grid) return
    const run = sim.run
    fireRef.current?.setArrival(run?.result.arrival ?? null)
    if (smokeRef.current) {
      smokeRef.current.cells = run?.cells ?? null
      smokeRef.current.times = run?.times ?? null
      smokeRef.current.windKmh = activeWeather.windKmh
      smokeRef.current.windFromDeg = activeWeather.windFromDeg
    }
    const src = map.getSource(ISO_SOURCE) as GeoJSONSource | undefined
    src?.setData({
      type: 'FeatureCollection',
      features: run
        ? run.result.isochrones.map((mp, i) => ({
            type: 'Feature',
            properties: { minutes: ISOCHRONES[i], label: `${ISOCHRONES[i] / 60} h` },
            geometry: { type: 'MultiPolygon', coordinates: mp.coordinates.map((poly) => poly.map((ring) => ring.map(([c, r]) => gridToLngLat(grid, c, r)))) },
          }))
        : [],
    })
    // reset ignited feature-states: homes lit by the previous run (e.g. ones an action just saved) must not stay charred
    ignitedPtrRef.current = 0
    for (const fid of prevIgnitedRef.current) map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { ignited: false })
    prevIgnitedRef.current = run ? [...run.ignitedAt.keys()] : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sim.run, data?.grid])

  // timeline clock
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let raf = 0
    const tick = (nowMs: number) => {
      const dt = (nowMs - last) / 1000
      last = nowMs
      setT((cur) => {
        const nt = cur + dt * speed
        if (nt >= HORIZON_MIN) {
          setPlaying(false)
          return HORIZON_MIN
        }
        return nt
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed])

  useEffect(() => {
    const map = mapRef.current
    const fire = fireRef.current
    const active = sim.run != null
    if (fire) {
      fire.t = active ? t : -1
      fire.playing = playing
    }
    if (smokeRef.current) {
      smokeRef.current.t = active ? t : -1
      smokeRef.current.playing = playing
    }
    map?.triggerRepaint()
    if (!map || !ready || map !== loadedMapRef.current) return
    map.setPaintProperty(L.isoLine, 'line-opacity', ['case', ['<=', ['get', 'minutes'], Math.floor(t)], 0.95, 0.35])
    // ignite homes as the front reaches them (pointer walks the time-sorted list; scrubbing back resets)
    const fs = (fid: number, v: boolean) => map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { ignited: v })
    let p = ignitedPtrRef.current
    if (p > 0 && (ignitionSorted[p - 1]?.[1] ?? 0) > t) {
      while (p > 0 && ignitionSorted[p - 1][1] > t) fs(ignitionSorted[--p][0], false)
    }
    while (p < ignitionSorted.length && ignitionSorted[p][1] <= t && active) fs(ignitionSorted[p++][0], true)
    ignitedPtrRef.current = p
  }, [t, playing, ready, sim.run, ignitionSorted])

  // ---- interactions
  const flyToHome = useCallback((b: BuildingRow) => {
    const map = mapRef.current
    if (!map) return
    map.flyTo({ center: [b.lon, b.lat], zoom: 17.6, pitch: 55, bearing: -25, duration: 1800, padding: { top: 0, bottom: 0, left: 400, right: 0 }, essential: true })
  }, [])

  const pickHome = useCallback(
    (b: BuildingRow) => {
      setSelected(b.fid)
      setSearchNote(null)
      setTab((cur) => (cur === 'sim' ? 'sim' : 'home'))
      flyToHome(b)
    },
    [flyToHome],
  )

  const onSearchHit = useCallback(
    (hit: GeocodeHit) => {
      let best: BuildingRow | null = null, bd = Infinity
      for (const b of buildings) {
        const d = distM(hit, b)
        if (d < bd) { bd = d; best = b }
      }
      if (best && bd <= 80) pickHome(best)
      else {
        setSearchNote(bd === Infinity || bd > 5000 ? `${hit.label} is outside the pilot area.` : `No footprint within 80 m of ${hit.label}.`)
        mapRef.current?.flyTo({ center: [hit.lon, hit.lat], zoom: 16, pitch: 0, duration: 1400 })
      }
    },
    [buildings, pickHome],
  )

  const catByIndex = useMemo(() => {
    const a: string[] = ['nodata']
    for (const c of data?.coverage.grid?.codes ?? []) a[c.index] = c.cat
    return a
  }, [data])
  const burnable = useCallback((cell: number) => data?.grid != null && BURNABLE.has(catByIndex[data.grid.fuel[cell]] ?? ''), [data?.grid, catByIndex])

  const startFire = useCallback(
    (ign: Ignition) => {
      setIgniting(false)
      setMapNote(null)
      setWeather(activeWeather)
      setT(0)
      setPlaying(true)
      setTab('sim')
      sim.simulate(ign, activeWeather, actions)
    },
    [activeWeather, actions, sim],
  )

  const ignite = useCallback(() => {
    const b = selected != null ? byFid.get(selected) : undefined
    if (b) startFire({ kind: 'home', fid: b.fid, lon: b.lon, lat: b.lat })
  }, [selected, byFid, startFire])

  /** Start at a point; `snapCells` > 0 moves it to the nearest forest cell within that many cells. */
  const igniteAt = useCallback(
    (lon: number, lat: number, opts: { zid?: number; snapCells?: number } = {}) => {
      const grid = data?.grid
      if (!grid) return
      let cell = cellOf(grid, lon, lat)
      if (cell < 0) {
        setMapNote('That point is outside the pilot area.')
        return
      }
      if (!burnable(cell)) {
        const col = cell % grid.width, row = (cell - col) / grid.width
        let found = -1
        for (let r = 1; r <= (opts.snapCells ?? 0) && found < 0; r++)
          for (let dr = -r; dr <= r && found < 0; dr++)
            for (let dc = -r; dc <= r; dc++) {
              const rr = row + dr, cc = col + dc
              if (Math.max(Math.abs(dr), Math.abs(dc)) !== r || rr < 0 || cc < 0 || rr >= grid.height || cc >= grid.width) continue
              if (burnable(rr * grid.width + cc)) {
                found = rr * grid.width + cc
                break
              }
            }
        if (found < 0) {
          setMapNote('No forest fuel there (water or non-fuel land). Pick a forest spot.')
          return
        }
        cell = found
      }
      const col = cell % grid.width, row = (cell - col) / grid.width
      const [clon, clat] = gridToLngLat(grid, col + 0.5, row + 0.5)
      startFire({ kind: 'point', cell, lon: clon, lat: clat, zid: opts.zid })
    },
    [data?.grid, burnable, startFire],
  )

  /** A random forest cell 300 m – 1 km from a random home, so the demo fire has something to threaten. */
  const igniteRandom = useCallback(() => {
    const grid = data?.grid
    if (!grid || !buildings.length) return
    for (let tries = 0; tries < 5000; tries++) {
      const b = buildings[Math.floor(Math.random() * buildings.length)]
      const d = 300 + Math.random() * 700, a = Math.random() * 2 * Math.PI
      const lat = b.lat + (d * Math.cos(a)) / 111_320
      const lon = b.lon + (d * Math.sin(a)) / (111_320 * Math.cos((b.lat * Math.PI) / 180))
      const cell = cellOf(grid, lon, lat)
      if (cell < 0 || !burnable(cell)) continue
      const col = cell % grid.width, row = (cell - col) / grid.width
      const [clon, clat] = gridToLngLat(grid, col + 0.5, row + 0.5)
      startFire({ kind: 'point', cell, lon: clon, lat: clat })
      return
    }
    setMapNote('Could not find a forest spot near homes.')
  }, [data?.grid, buildings, burnable, startFire])

  useEffect(() => {
    if (!mapNote) return
    const t = setTimeout(() => setMapNote(null), 4000)
    return () => clearTimeout(t)
  }, [mapNote])

  clickRef.current = (e: MapMouseEvent) => {
    const map = mapRef.current
    if (!map) return
    const d = drawingRef.current
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
    if (d !== false) {
      if (d === null) setDrawing(p)
      else {
        setActions((a) => ({ ...a, breaks: [...a.breaks, [d, p] as FuelBreak] }))
        setDrawing(false)
      }
      return
    }
    if (igniting) {
      igniteAt(p[0], p[1])
      return
    }
    if (!map.getLayer(L.zonesFill)) return
    const hits = map.queryRenderedFeatures(e.point, { layers: [L.buildingsFill, L.zonesFill, L.densityFill] })
    const home = hits.find((f) => f.layer.id === L.buildingsFill)
    if (home) {
      setSelected(Number(home.id ?? home.properties.fid))
      setSearchNote(null)
      setTab((cur) => (cur === 'sim' ? 'sim' : 'home'))
      return
    }
    const zone = hits.find((f) => f.layer.id === L.zonesFill)
    if (zone) {
      setSelectedZone(Number(zone.id))
      setTab((cur) => (cur === 'sim' ? 'sim' : 'zone'))
      return
    }
    const dens = hits.find((f) => f.layer.id === L.densityFill)
    if (dens) {
      setSelectedDensity(Number(dens.id))
      setTab((cur) => (cur === 'sim' ? 'sim' : 'density'))
    }
  }

  // frame the 12 h burned extent once the untouched run is solved
  const framedRef = useRef<typeof sim.baseline>(null)
  useEffect(() => {
    const map = mapRef.current, grid = data?.grid, base = sim.baseline
    if (!map || !grid || !base || framedRef.current === base) return
    framedRef.current = base
    const { cells } = base
    if (!cells.length) return
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity
    for (let i = 0; i < cells.length; i++) {
      const col = cells[i] % grid.width, row = (cells[i] - col) / grid.width
      if (col < c0) c0 = col
      if (col > c1) c1 = col
      if (row < r0) r0 = row
      if (row > r1) r1 = row
    }
    const [w, n] = gridToLngLat(grid, c0 - 1, r0 - 1)
    const [e, s] = gridToLngLat(grid, c1 + 2, r1 + 2)
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: { top: 80, bottom: 120, left: 440, right: 60 }, pitch: 45, bearing: map.getBearing(), duration: 2400, maxZoom: 16 },
    )
  }, [sim.baseline, data?.grid])

  const exitSim = useCallback(() => {
    setPlaying(false)
    setT(0)
    sim.reset()
    setActions(NO_ACTIONS)
    setDrawing(false)
    setIgniting(false)
    setWeather(null)
    setTab(selected != null ? 'home' : selectedZone != null ? 'zone' : selectedDensity != null ? 'density' : 'overview')
  }, [sim, selected, selectedZone, selectedDensity])

  const clearTop = useCallback(
    (n: number) => {
      if (!sim.run) return
      const next = new Set(actions.cleared)
      for (const [fid] of ignitionSorted) {
        if (next.size >= actions.cleared.size + n) break
        if (!(sim.run.ignition.kind === 'home' && fid === sim.run.ignition.fid)) next.add(fid)
      }
      setActions((a) => ({ ...a, cleared: next }))
    },
    [sim.run, actions.cleared, ignitionSorted],
  )

  const applySuggestion = useCallback((s: Suggestion) => setActions((a) => withSuggestion(a, s)), [])

  const toggleCleared = useCallback((fid: number) => {
    setActions((a) => {
      const cleared = new Set(a.cleared)
      if (cleared.has(fid)) cleared.delete(fid)
      else cleared.add(fid)
      return { ...a, cleared }
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawingRef.current !== false) setDrawing(false)
        else if (ignitingRef.current) setIgniting(false)
        else if (tab === 'home') { setSelected(null); setTab('overview') }
        else if (tab === 'zone') { setSelectedZone(null); setTab('overview') }
        else if (tab === 'density') { setSelectedDensity(null); setTab('overview') }
      }
      if (e.key === ' ' && sim.run && (e.target as HTMLElement)?.tagName !== 'INPUT') { e.preventDefault(); setPlaying((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, sim.run])

  const zoneList = useMemo(() => data?.zones.features.map((f) => f.properties) ?? [], [data])
  const water = useMemo(() => {
    const run = sim.run, grid = data?.grid
    if (!run || !grid) return null
    return waterEdge(run.result.arrival, grid.fuel, (i) => catByIndex[i] === 'water', grid.width, grid.height, run.ignitionCell)
  }, [sim.run, data?.grid, catByIndex])
  // which homes sit in each high-density area, for the evacuation order
  const densityHomes = useMemo(() => {
    if (!data) return []
    const inside = (lon: number, lat: number, ring: number[][]) => {
      let c = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j]
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c
      }
      return c
    }
    return data.density.features.map((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      const [w, sN, e, n] = polys.flat(1).flat().reduce<[number, number, number, number]>((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity])
      const homeIdx: number[] = []
      data.buildings.forEach((b, i) => {
        if (b.lon < w || b.lon > e || b.lat < sN || b.lat > n) return
        if (polys.some((p) => inside(b.lon, b.lat, p[0]))) homeIdx.push(i)
      })
      return { item: f.properties, homeIdx }
    })
  }, [data])
  const evacuation = useMemo(() => (sim.run ? evacuationOrder(densityHomes, sim.run.result.ignition).filter((e) => e.minutes != null) : []), [sim.run, densityHomes])
  const originPlace = usePlaceName(runIgnition?.lon, runIgnition?.lat)
  const coords = runIgnition ? `${runIgnition.lat.toFixed(4)}, ${runIgnition.lon.toFixed(4)}` : ''
  const originLabel = !runIgnition
    ? '…'
    : runIgnition.kind === 'home'
      ? (originPlace ?? `home #${runIgnition.fid}`)
      : `${runIgnition.zid != null ? 'zone ' : ''}${originPlace ? `near ${originPlace}` : coords}`
  const toggleLayer = (k: LayerKey) => setLayers((l) => ({ ...l, [k]: !l[k] }))

  // ---- render
  if (error)
    return (
      <Frame>
        <div className="ops bp6-dark grid min-h-0 flex-1 place-items-center">
        <div className="panel max-w-sm p-5">
          <div className="label">Data unavailable</div>
          <p className="mt-2 text-sm">Couldn't load the pilot dataset ({error}). Run <code>data/wildfire/pipeline.py</code> to generate it.</p>
        </div>
      </div>
      </Frame>
    )

  const selectedRow = selected != null ? byFid.get(selected) ?? null : null
  const zoneRow = selectedZone != null ? data?.byZid.get(selectedZone) ?? null : null
  const densityRow = selectedDensity != null ? data?.byDid.get(selectedDensity) ?? null : null
  const ffmc = ffmcClass(dryness.data?.ffmc ?? null)
  const risks = buildings.map((b) => riskOf(b.exposure, dry))
  const critical = risks.filter((r) => bandOf(r) === 'critical').length
  const ignitedNow = sim.run ? lowerBound(Float32Array.from(ignitionSorted.map(([, m]) => m)), t + 1e-6) : 0
  const burnedHaNow = sim.run && data?.grid ? (lowerBound(sim.run.times, t + 1e-6) * data.grid.cellM ** 2) / 10_000 : 0

  return (
    <Frame>
    <div className={`ops bp6-dark relative min-h-0 w-full flex-1 overflow-hidden ${sim.run ? 'sim-on' : ''}`}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={smokeCanvasRef} className="pointer-events-none absolute inset-0" />
      <canvas ref={windCanvasRef} className="pointer-events-none absolute inset-0" />
      {!ready && (
        <div className="grid-bg absolute inset-0 grid place-items-center" style={{ background: 'var(--ops-bg)' }}>
          <div className="flex items-center gap-3">
            <Spinner size={20} />
            <span className="label">Loading pilot · {data?.coverage.area_name ?? '…'}</span>
          </div>
        </div>
      )}

      {/* search, top left */}
      <div className="pointer-events-none absolute top-3 left-3 z-20 w-[380px]">
        <SearchBar bias={centre} onPick={onSearchHit} />
        {searchNote && <p className="panel pointer-events-auto mt-1 px-3 py-1 text-[11px]" style={{ color: 'var(--ops-amber)' }}>{searchNote}</p>}
      </div>

      {/* status + layers, top right */}
      <div className="pointer-events-none absolute top-3 right-3 flex flex-col items-end gap-2">
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="panel flex items-center gap-3 px-3 py-1.5">
            <Flame size={14} style={{ color: 'var(--ops-red)' }} />
            <span className="mono text-xs tracking-widest uppercase">Wildfire Ops</span>
            <HTMLSelect
              minimal
              value={area?.id ?? ''}
              onChange={(e) => setAreaId(e.currentTarget.value)}
              options={areas.map((a) => ({ value: a.id, label: a.name }))}
              className="mono text-xs"
              aria-label="Area"
            />
            <span className="mono hidden text-xs 2xl:inline" style={{ color: 'var(--ops-muted)' }}>{now.toISOString().slice(0, 19).replace('T', ' ')}Z</span>
          </div>
          <div className="panel flex items-center gap-2 px-3 py-1.5">
            <span className="h-2 w-2 blink" style={{ background: ffmc.color, boxShadow: `0 0 8px ${ffmc.color}` }} />
            <span className="label">FFMC</span>
            <span className="mono text-sm">{dryness.data?.ffmc != null ? dryness.data.ffmc.toFixed(1) : '–'}</span>
            <Tag minimal style={{ color: ffmc.color }} className="mono">{ffmc.label}</Tag>
            <span className="label hair border-l pl-2">Wind</span>
            <span className="mono text-sm">{Math.round(wind.speedKmh)} km/h · {Math.round(wind.fromDeg)}°</span>
          </div>
          <div className="panel flex items-center gap-1 px-1 py-1">
            <Button small minimal icon={<Layers />} active={layersOpen} onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen}>
              <span className="mono text-[11px]">LAYERS</span>
            </Button>
            <Button small minimal icon={<Satellite />} active={satellite} onClick={() => setSatellite((s) => !s)} title={imagery?.date ? `Imagery ${imagery.date}` : 'Satellite imagery'}>
              <span className="mono text-[11px]">{satellite ? (imagery?.date ?? 'SAT') : 'DARK'}</span>
            </Button>
            <Button small minimal icon={<Locate />} title="Reset view" onClick={() => data && mapRef.current?.fitBounds(data.coverage.bbox as LngLatBoundsLike, { padding: { top: 60, bottom: 60, left: 440, right: 60 }, pitch: 0, bearing: 0, duration: 1600 })} />
          </div>
        </div>
        {layersOpen && (
          <div className="panel rise pointer-events-auto w-[300px] px-3 pt-3 pb-1">
            <div className="label mb-2">Map layers</div>
            <Checkbox checked={layers.zones} onChange={() => toggleLayer('zones')} labelElement={<LayerLabel color={ZONE_ORANGE} text="High fire-risk zones" />} />
            <Checkbox checked={layers.homes} onChange={() => toggleLayer('homes')} labelElement={<LayerLabel color="#ffb366" text="Home ignition risk" />} />
            <Checkbox checked={layers.density} onChange={() => toggleLayer('density')} labelElement={<LayerLabel color="#3d8bff" text="High-density home areas" />} />
            <Checkbox checked={layers.wind} onChange={() => toggleLayer('wind')} labelElement={<LayerLabel color="#d6e8ff" text="Wind" />} />
            {layers.wind && (
              <p className="mb-2 text-[11px]" style={{ color: 'var(--ops-muted)' }}>
                {windField
                  ? `Live Open-Meteo wind at 16 points, ${Math.round(windField.speedMin)}–${Math.round(windField.speedMax)} km/h, interpolated between them. The fire model uses the centre reading.`
                  : 'Loading Open-Meteo wind…'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* left ops panel */}
      <aside className="panel rise pointer-events-auto absolute top-[70px] bottom-3 left-3 flex w-[380px] flex-col overflow-hidden">
        <div className="hair flex border-b">
          {(
            [
              ['overview', 'Overview', <Layers size={12} key="o" />],
              ['zone', 'Zone', <Tree size={12} key="z" />],
              ['density', 'Homes', <Home size={12} key="d" />],
              ['home', 'Home', <Locate size={12} key="h" />],
              ['sim', 'Simulation', <Flame size={12} key="s" />],
            ] as [Tab, string, ReactElement][]
          ).map(([k, label, icon]) => {
            const disabled = (k === 'zone' && !zoneRow) || (k === 'density' && !densityRow) || (k === 'home' && !selectedRow) || (k === 'sim' && !sim.run && sim.status !== 'running')
            return (
              <button
                key={k}
                type="button"
                disabled={disabled}
                onClick={() => setTab(k)}
                className="label flex flex-1 items-center justify-center gap-1.5 py-2.5 disabled:opacity-30"
                style={tab === k ? { color: 'var(--ops-cyan)', boxShadow: 'inset 0 -2px 0 var(--ops-cyan)' } : undefined}
              >
                {icon}{label}
              </button>
            )
          })}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!data && <div className="p-4"><Spinner size={18} /></div>}
          {data && tab === 'overview' && (
            <OverviewTab
              buildings={buildings}
              dryness={dry}
              zones={zoneList}
              onRandomIgnite={igniteRandom}
              clickIgnite={igniting}
              onClickIgnite={() => {
                setDrawing(false)
                setIgniting((v) => !v)
              }}
              disabled={!data.grid}
            />
          )}
          {data && tab === 'density' && densityRow && (
            <DensityTab
              d={densityRow}
              onBack={() => { setSelectedDensity(null); setTab('overview') }}
              onShow={() => setLayers((l) => ({ ...l, density: true }))}
              shown={layers.density}
            />
          )}
          {data && tab === 'zone' && zoneRow && (
            <ZoneTab
              z={zoneRow}
              dryness={dryness.data}
              categories={data.categories}
              onIgnite={() => igniteAt(zoneRow.lon, zoneRow.lat, { zid: zoneRow.zid, snapCells: 10 })}
              onBack={() => { setSelectedZone(null); setTab('overview') }}
              simulating={sim.status === 'running'}
            />
          )}
          {data && tab === 'home' && selectedRow && (
            <HomeTab
              b={selectedRow}
              dryness={dryness.data}
              drynessFactor={dry}
              weights={data.coverage.risk?.weights ?? DEFAULT_WEIGHTS}
              neighbourCap={data.coverage.risk?.neighbour_cap ?? 4}
              cleared={actions.cleared.has(selectedRow.fid)}
              onToggleCleared={() => toggleCleared(selectedRow.fid)}
              onIgnite={ignite}
              onBack={() => { setSelected(null); setTab('overview') }}
              simulating={sim.status === 'running'}
            />
          )}
          {data && tab === 'sim' && (
            <SimTab
              run={sim.run}
              baseline={sim.baseline}
              status={sim.status}
              t={t}
              weather={activeWeather}
              liveWeather={liveWeather}
              windSource={wind.source === 'open-meteo' ? 'live · open-meteo + cwfis' : 'default wind'}
              onWeather={setWeather}
              actions={actions}
              byFid={byFid}
              drawingBreak={drawing !== false}
              onDrawBreak={() => {
                setIgniting(false)
                setDrawing((d) => (d === false ? null : false))
              }}
              onClearTop={clearTop}
              onResetActions={() => setActions(NO_ACTIONS)}
              onPick={pickHome}
              onExit={exitSim}
              dryness={dry}
              origin={originLabel}
              suggest={suggestNow}
              onFindSuggestions={() => sim.run && sim.findSuggestions(sim.run)}
              onApplySuggestion={applySuggestion}
              water={water}
              evacuation={evacuation}
              onPickDensity={(did) => { setSelectedDensity(did); setLayers((l) => ({ ...l, density: true })) }}
            />
          )}
        </div>
        <div className="hair flex items-center justify-between border-t px-3 py-1.5">
          <span className="label">{buildings.length.toLocaleString()} homes · {critical} critical today</span>
          <span className="label">{dryness.status === 'ok' ? `CWFIS ${dryness.data?.date}` : dryness.status === 'loading' ? 'CWFIS …' : 'CWFIS offline'}</span>
        </div>
      </aside>

      {/* bottom timeline */}
      {sim.run && (
        <div className="pointer-events-none absolute right-3 bottom-3 left-[404px]">
          <Timeline
            t={t}
            playing={playing}
            speed={speed}
            burnedHa={burnedHaNow}
            ignited={ignitedNow}
            ignitedTotal={sim.run.result.ignitedHomes}
            onPlay={setPlaying}
            onScrub={(v) => { setT(v) }}
            onSpeed={setSpeed}
          />
        </div>
      )}
      {drawing === false && (igniting || mapNote) && (
        <div className="pointer-events-none absolute top-[72px] left-1/2 -translate-x-1/2">
          <Tag large intent={mapNote ? 'warning' : 'danger'} className="mono">{mapNote ?? 'Click a forest spot to start a fire · Esc to cancel'}</Tag>
        </div>
      )}
      {drawing !== false && (
        <div className="pointer-events-none absolute top-[72px] left-1/2 -translate-x-1/2">
          <Tag large intent="success" className="mono">{drawing === null ? 'Click the start of the fuel break' : 'Click the end of the fuel break · Esc to cancel'}</Tag>
        </div>
      )}
    </div>
    </Frame>
  )
}

/** The console under the shared top bar (PRODUCT.md): it keeps its own dark look, so no theme toggle. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="ember">
        <TopBar page="/wildfire" themeToggle={false} />
      </div>
      {children}
    </div>
  )
}

function LayerLabel({ color, text }: { color: string; text: string }) {
  return (
    <span className="text-xs">
      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      {text}
    </span>
  )
}
