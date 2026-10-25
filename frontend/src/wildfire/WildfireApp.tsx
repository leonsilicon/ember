import { Button, Spinner, Tag } from '@blueprintjs/core'
import { Flame, Geolocation as Locate, Home, Layers } from '@blueprintjs/icons'
import {
  Map as MLMap,
  NavigationControl,
  ScaleControl,
  addProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { TopBar } from '../rover/ui/Shell'
import type { GeocodeHit } from './geocode'
import { drynessFactor, ffmcClass, useDryness, useImageryInfo, useWind } from './live'
import {
  BASEMAP,
  BREAKS_SOURCE,
  BUILDINGS_SOURCE,
  ISO_SOURCE,
  L,
  NO_SELECTION,
  SATELLITE_SOURCE,
  breaksLayer,
  buildingLayers,
  firstSymbolLayer,
  isochroneLayers,
  restyleBuildings,
  satelliteLayer,
  satelliteSource,
  selectedLayers,
} from './mapLayers'
import { HomesTab, HomeTab, SimTab } from './OpsPanel'
import { SearchBar } from './SearchBar'
import type { FbpInputs } from './sim/fbp'
import { FireLayer } from './sim/FireLayer'
import { gridToLngLat } from './sim/grid'
import { Smoke } from './sim/Smoke'
import { HORIZON_MIN, ISOCHRONES, lowerBound, useSimulation, type FuelBreak, type SimActions } from './sim/useSimulation'
import { Timeline } from './Timeline'
import { bandOf, drynessMultiplier, riskOf, type Band, type BuildingRow } from './types'
import { DATA_BASE, useWildfireData } from './useWildfireData'

// Under Turbopack, maplibre's own `import.meta.url` is not an http(s) URL, so its default worker URL
// comes out empty and every map fails with "Worker failed to load"; point it at the bundled worker.
setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href)
const protocol = new Protocol()
addProtocol('pmtiles', protocol.tile)

type Tab = 'homes' | 'home' | 'sim'
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
  const { data, error } = useWildfireData()
  const containerRef = useRef<HTMLDivElement>(null)
  const smokeCanvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const fireRef = useRef<FireLayer | null>(null)
  const smokeRef = useRef<Smoke | null>(null)
  const basemapIdsRef = useRef<string[]>([])
  const [ready, setReady] = useState(false)
  const [satellite, setSatellite] = useState(true)
  const [tab, setTab] = useState<Tab>('homes')
  const [filter, setFilter] = useState<Band | 'all'>('all')
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
  const sim = useSimulation(data?.grid ?? null, buildings)
  const [weather, setWeather] = useState<FbpInputs | null>(null)
  const [actions, setActions] = useState<SimActions>({ cleared: new Set(), breaks: [] })
  const [drawing, setDrawing] = useState<[number, number] | null | false>(false) // false = not drawing, null = waiting for 1st point
  const drawingRef = useRef(drawing)
  drawingRef.current = drawing
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
    const abs = (p: string) => new URL(`${DATA_BASE}${p}`, window.location.href).href

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
      setReady(true)
    })

    map.on('click', (e: MapMouseEvent) => {
      const d = drawingRef.current
      if (d === false) return
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      if (d === null) setDrawing(p)
      else {
        setActions((a) => ({ ...a, breaks: [...a.breaks, [d, p] as FuelBreak] }))
        setDrawing(false)
      }
    })
    map.on('click', L.buildingsFill, (e: MapLayerMouseEvent) => {
      if (drawingRef.current !== false) return
      const f = e.features?.[0]
      if (!f) return
      const fid = Number(f.id ?? f.properties.fid)
      setSelected(fid)
      setTab((cur) => (cur === 'sim' ? 'sim' : 'home'))
    })
    map.on('mouseenter', L.buildingsFill, () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', L.buildingsFill, () => (map.getCanvas().style.cursor = ''))
    map.on('move', () => {
      const c = map.getCenter()
      setView({ lon: c.lng, lat: c.lat, zoom: map.getZoom() })
    })
    map.on('resize', () => smokeRef.current?.resize())

    return () => {
      smokeRef.current?.destroy()
      smokeRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [data])

  // today's dryness recolours every footprint
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    restyleBuildings(map, drynessMultiplier(dry))
  }, [ready, dry])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    map.setLayoutProperty(L.satellite, 'visibility', satellite ? 'visible' : 'none')
    for (const id of basemapIdsRef.current) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible')
  }, [ready, satellite])

  // selection highlight
  const prevSelected = useRef<number | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const fs = (fid: number, v: boolean) => map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { selected: v })
    if (prevSelected.current != null) fs(prevSelected.current, false)
    if (selected != null) fs(selected, true)
    prevSelected.current = selected
    map.setFilter(L.selectedRing, selected != null ? ['==', ['id'], selected] : NO_SELECTION)
  }, [ready, selected])

  // cleared homes highlight
  const prevCleared = useRef<Set<number>>(new Set())
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    for (const fid of prevCleared.current) if (!actions.cleared.has(fid)) map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { cleared: false })
    for (const fid of actions.cleared) map.setFeatureState({ source: BUILDINGS_SOURCE, sourceLayer: 'buildings', id: fid }, { cleared: true })
    prevCleared.current = new Set(actions.cleared)
  }, [ready, actions.cleared])

  // fuel breaks on the map
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const src = map.getSource(BREAKS_SOURCE) as GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: actions.breaks.map((b) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: b } })) })
    map.getCanvas().style.cursor = drawing !== false ? 'crosshair' : ''
  }, [ready, actions.breaks, drawing])

  // re-run when actions or weather change while a simulation is live
  const runFid = sim.run?.ignitionFid ?? null
  useEffect(() => {
    if (runFid == null) return
    sim.simulate(runFid, activeWeather, actions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, activeWeather, runFid])

  // push results into the map: arrival texture, isochrones, smoke source
  const ignitionSorted = useMemo(() => (sim.run ? [...sim.run.ignitedAt.entries()].sort((a, b) => a[1] - b[1]) : []), [sim.run])
  useEffect(() => {
    const map = mapRef.current
    const grid = data?.grid
    if (!ready || !map || !grid) return
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
    if (!map || !ready) return
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

  const ignite = useCallback(() => {
    if (selected == null) return
    setWeather(activeWeather)
    setT(0)
    setPlaying(true)
    setTab('sim')
    sim.simulate(selected, activeWeather, actions)
  }, [selected, activeWeather, actions, sim])

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
    setActions({ cleared: new Set(), breaks: [] })
    setDrawing(false)
    setWeather(null)
    setTab(selected != null ? 'home' : 'homes')
  }, [sim, selected])

  const clearTop = useCallback(
    (n: number) => {
      if (!sim.run) return
      const next = new Set(actions.cleared)
      for (const [fid] of ignitionSorted) {
        if (next.size >= actions.cleared.size + n) break
        if (fid !== sim.run.ignitionFid) next.add(fid)
      }
      setActions((a) => ({ ...a, cleared: next }))
    },
    [sim.run, actions.cleared, ignitionSorted],
  )

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
        else if (tab === 'home') { setSelected(null); setTab('homes') }
      }
      if (e.key === ' ' && sim.run && (e.target as HTMLElement)?.tagName !== 'INPUT') { e.preventDefault(); setPlaying((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, sim.run])

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
      {!ready && (
        <div className="grid-bg absolute inset-0 grid place-items-center" style={{ background: 'var(--ops-bg)' }}>
          <div className="flex items-center gap-3">
            <Spinner size={20} />
            <span className="label">Loading pilot · {data?.coverage.area_name ?? '…'}</span>
          </div>
        </div>
      )}

      {/* top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="panel pointer-events-auto flex items-center gap-3 px-3 py-1.5">
          <Flame size={14} style={{ color: 'var(--ops-red)' }} />
          <span className="mono text-xs tracking-widest uppercase">Wildfire Ops</span>
          <span className="hair border-l pl-3 text-xs" style={{ color: 'var(--ops-muted)' }}>{data?.coverage.area_name ?? '…'}</span>
          <span className="mono text-xs" style={{ color: 'var(--ops-muted)' }}>{now.toISOString().slice(0, 19).replace('T', ' ')}Z</span>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="panel flex items-center gap-2 px-3 py-1.5">
            <span className="h-2 w-2 blink" style={{ background: ffmc.color, boxShadow: `0 0 8px ${ffmc.color}` }} />
            <span className="label">FFMC</span>
            <span className="mono text-sm">{dryness.data?.ffmc != null ? dryness.data.ffmc.toFixed(1) : '–'}</span>
            <Tag minimal style={{ color: ffmc.color }} className="mono">{ffmc.label}</Tag>
            <span className="label hair border-l pl-2">Wind</span>
            <span className="mono text-sm">{Math.round(wind.speedKmh)} km/h · {Math.round(wind.fromDeg)}°</span>
          </div>
          <div className="panel flex items-center gap-1 px-1 py-1">
            <Button small minimal icon={<Layers />} active={satellite} onClick={() => setSatellite((s) => !s)} title={imagery?.date ? `Imagery ${imagery.date}` : 'Satellite imagery'}>
              <span className="mono text-[11px]">{satellite ? (imagery?.date ?? 'SAT') : 'DARK'}</span>
            </Button>
            <Button
              small
              minimal
              icon={<Locate />}
              title="Reset view"
              onClick={() => data && mapRef.current?.fitBounds(data.coverage.bbox as LngLatBoundsLike, { padding: { top: 60, bottom: 60, left: 440, right: 60 }, pitch: 0, bearing: 0, duration: 1600 })}
            />
          </div>
        </div>
      </div>

      {/* left ops panel */}
      <aside className="panel rise pointer-events-auto absolute top-14 bottom-3 left-3 flex w-[380px] flex-col overflow-hidden">
        <div className="hair flex border-b">
          {(
            [
              ['homes', 'Homes', <Home size={12} key="h" />],
              ['home', 'Home', <Locate size={12} key="d" />],
              ['sim', 'Simulation', <Flame size={12} key="s" />],
            ] as [Tab, string, ReactElement][]
          ).map(([k, label, icon]) => {
            const disabled = (k === 'home' && !selectedRow) || (k === 'sim' && !sim.run && sim.status !== 'running')
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
        {tab === 'homes' && (
          <div className="p-2 hair border-b">
            <SearchBar bias={centre} onPick={onSearchHit} />
            {searchNote && <p className="mt-1 px-1 text-[11px]" style={{ color: 'var(--ops-amber)' }}>{searchNote}</p>}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {!data && <div className="p-4"><Spinner size={18} /></div>}
          {data && tab === 'homes' && <HomesTab buildings={buildings} dryness={dry} filter={filter} onFilter={setFilter} selected={selected} onPick={pickHome} />}
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
              onBack={() => { setSelected(null); setTab('homes') }}
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
              onDrawBreak={() => setDrawing((d) => (d === false ? null : false))}
              onClearTop={clearTop}
              onResetActions={() => setActions({ cleared: new Set(), breaks: [] })}
              onPick={pickHome}
              onExit={exitSim}
              dryness={dry}
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
      {drawing !== false && (
        <div className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2">
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
