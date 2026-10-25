import { Button, ProgressBar, Slider, Spinner, Tag } from '@blueprintjs/core'
import { ArrowLeft, Cross, Flame, Lightbulb, MapMarker, Random, Shield, Tick, Tree, Wind } from '@blueprintjs/icons'
import { useState, type ReactNode } from 'react'
import { usePlaceName } from './geocode'
import { ffmcClass, type Dryness } from './live'
import { DENSITY_BLUE, ZONE_ORANGE } from './mapLayers'
import type { FbpInputs } from './sim/fbp'
import { CLEARED_FACTOR } from './sim/protocol'
import type { Suggestion } from './sim/suggest'
import { hasAnyAction, type SimActions, type SimRun, type SuggestState } from './sim/useSimulation'
import { fmtClock } from './format'
import { BAND, bandOf, drynessMultiplier, riskOf, type Band, type BuildingRow, type Categories, type DensityProps, type ZoneProps } from './types'

// ---------------------------------------------------------------- shared bits

export function RiskTag({ risk }: { risk: number }) {
  const b = BAND[bandOf(risk)]
  return (
    <Tag minimal intent={b.intent} className="mono" style={{ minWidth: 34, justifyContent: 'center' }}>
      {risk}
    </Tag>
  )
}

function Row({ b, risk, active, onClick, trailing }: { b: BuildingRow; risk: number; active: boolean; onClick: () => void; trailing?: ReactNode }) {
  const place = usePlaceName(b.lon, b.lat)
  return (
    <button type="button" onClick={onClick} className={`row-hover flex w-full items-center gap-3 border-b px-3 py-2 text-left hair ${active ? 'selected' : ''}`}>
      <span className="h-2 w-2 shrink-0" style={{ background: BAND[bandOf(risk)].color, boxShadow: `0 0 8px ${BAND[bandOf(risk)].color}` }} />
      <span className="flex-1 truncate">
        <span className="text-xs">{place ?? `Home #${b.fid}`}</span>
        <span className="ml-2 text-[11px]" style={{ color: 'var(--ops-muted)' }}>{Math.round(b.area_m2)} m²</span>
      </span>
      {trailing}
      <RiskTag risk={risk} />
    </button>
  )
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="border-b hair">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="label">{title}</span>
        {right}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- Overview

interface OverviewProps {
  buildings: BuildingRow[]
  dryness: number
  zones: ZoneProps[]
  onRandomIgnite: () => void
  clickIgnite: boolean
  onClickIgnite: () => void
  disabled: boolean
}

export function OverviewTab({ buildings, dryness, zones, onRandomIgnite, clickIgnite, onClickIgnite, disabled }: OverviewProps) {
  const counts: Record<Band, number> = { critical: 0, elevated: 0, low: 0 }
  for (const b of buildings) counts[bandOf(riskOf(b.exposure, dryness))]++
  const ha = zones.reduce((s, z) => s + z.area_ha, 0)
  const near = zones.reduce((s, z) => s + z.homes_30m, 0)
  return (
    <>
      <div className="scan relative border-b p-4 hair" style={{ background: `linear-gradient(180deg, ${ZONE_ORANGE}26, transparent)` }}>
        <div className="label">High fire-risk zones</div>
        <div className="mt-1 flex items-end gap-3">
          <div className="mono text-5xl leading-none" style={{ color: ZONE_ORANGE, textShadow: `0 0 24px ${ZONE_ORANGE}88` }}>{zones.length}</div>
          <div className="pb-0.5 text-xs" style={{ color: 'var(--ops-muted)' }}>
            {Math.round(ha).toLocaleString()} ha of high-hazard forest
            <br />
            {near.toLocaleString()} homes inside or within 30 m of one
          </div>
        </div>
        <p className="mt-3 text-xs" style={{ color: 'var(--ops-muted)' }}>Click an orange zone or a home on the map to see why it is at risk and what to do about it.</p>
      </div>
      <div className="grid grid-cols-3 border-b hair">
        {(['critical', 'elevated', 'low'] as Band[]).map((k) => (
          <div key={k} className="border-r p-3 last:border-r-0 hair">
            <div className="label" style={{ color: BAND[k].color }}>{BAND[k].label}</div>
            <div className="mono text-2xl leading-tight">{counts[k].toLocaleString()}</div>
            <div className="text-[10px]" style={{ color: 'var(--ops-muted)' }}>homes today</div>
          </div>
        ))}
      </div>
      <Section title="Start a fire">
        <div className="space-y-2">
          <Button fill alignText="left" intent="danger" minimal icon={<Random />} onClick={onRandomIgnite} disabled={disabled}>
            Random ignition in the forest
          </Button>
          <Button fill alignText="left" intent="danger" minimal icon={<MapMarker />} active={clickIgnite} onClick={onClickIgnite} disabled={disabled}>
            {clickIgnite ? 'Click a forest spot on the map…' : 'Click the map to ignite'}
          </Button>
          <p className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>Random picks a forest spot 0.3–1 km from homes. Fires use today's live wind and dryness; zone and home cards can start one too.</p>
        </div>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Zone

/** Plain-English note per FBP fuel type (Canadian Forest Fire Behavior Prediction System), keyed by code prefix. */
const FUEL_NOTES: [string, string][] = [
  ['C-1', 'open spruce-lichen woodland: sparse but very dry; fire moves fast across the ground'],
  ['C-2', 'dense black-spruce forest with low branches and mossy ground; the fastest, hottest crown fires in Ontario'],
  ['C-3', 'mature jack or lodgepole pine: fire stays on the ground until wind pushes it into the crowns'],
  ['C-4', 'young, crowded pine with dead lower branches: a ladder that carries fire straight into the canopy'],
  ['C-5', 'red and white pine: thick bark and high crowns, so mostly surface fire unless it is very dry'],
  ['C-6', 'pine plantation: evenly spaced trees whose touching crowns let fire run tree to tree'],
  ['C-7', 'open ponderosa-type pine and grass: grass carries the fire, the trees usually survive'],
  ['D-1', 'leafless hardwoods: the risk is the dry leaf litter on the ground, mostly in spring and fall'],
  ['M-1', 'mixed conifer and hardwood in spring: the conifer share decides how hot it burns'],
  ['M-2', 'mixed conifer and hardwood in summer: green leaves damp the fire, the conifers still carry it'],
  ['M-3', 'dead balsam fir mixed in after budworm: standing dead fuel that burns intensely'],
  ['M-4', 'dead balsam fir mixed in, green hardwoods: burns hard in spring before leaf-out'],
  ['O-1', 'grass: fast-moving, low-intensity fire that reaches homes quickly in wind'],
  ['S-1', 'logging slash (jack pine): heavy dead fuel on the ground that burns long and hot'],
  ['S-2', 'logging slash (spruce / fir): heavy dead fuel on the ground that burns long and hot'],
  ['S-3', 'logging slash (coastal conifers): heavy dead fuel on the ground'],
]

function fuelNote(fuel: string | null): string | null {
  if (!fuel) return null
  const hit = FUEL_NOTES.find(([k]) => fuel.startsWith(k) || fuel.includes(`/${k}`))
  return hit ? hit[1] : null
}

interface ZoneTabProps {
  z: ZoneProps
  dryness: Dryness | null
  categories: Categories
  onIgnite: () => void
  onBack: () => void
  simulating: boolean
}

const pct = (v: number) => `${Math.round(v * 100)} %`

export function ZoneTab({ z, dryness, categories, onIgnite, onBack, simulating }: ZoneTabProps) {
  const place = usePlaceName(z.lon, z.lat)
  const note = fuelNote(z.top_fuel)
  const src = categories.source
  const ff = ffmcClass(dryness?.ffmc ?? null)
  const mix = z.fuel_mix
  const conifer = (mix.extreme ?? 0) + (mix.high ?? 0) + (mix.pine_eval ?? 0)
  const drivers = [
    { k: 'High-hazard conifer', v: conifer, note: z.top_fuel ? `mostly ${z.top_fuel}` : undefined },
    { k: 'Mixedwood (moderate)', v: mix.moderate ?? 0 },
    { k: 'Fresh leaf litter (leaf-off)', v: z.leafoff_share },
  ]
  const steps: { icon: ReactNode; title: string; text: string }[] = []
  if (conifer >= 0.3)
    steps.push({ icon: <Tree size={12} />, title: 'Thin the conifers', text: `${pct(conifer)} of this zone is high-hazard conifer. Thinning and removing low branches keeps a surface fire from climbing into the crowns.` })
  if (z.homes_500m > 0)
    steps.push({ icon: <Tree size={12} />, title: 'Cut a fuel break towards the homes', text: `${z.homes_500m} homes are within 500 m. A 90 m break on the side facing them gives crews a line to hold. Simulate a fire to see where it pays off.` })
  if (z.leafoff_share >= 0.05)
    steps.push({ icon: <Tree size={12} />, title: 'Rake out fresh leaf litter', text: `${pct(z.leafoff_share)} of the zone dropped its leaves in the last month (Sentinel-2). Dry litter carries surface fire.` })
  if (z.homes_30m > 0)
    steps.push({ icon: <Shield size={12} />, title: 'Clear the 30 m zone around homes', text: `${z.homes_30m} home${z.homes_30m === 1 ? ' is' : 's are'} inside or within 30 m of this zone. FireSmart 0–30 m clearing is the owner's most effective step.` })
  if (z.water_m != null && z.water_m <= 150)
    steps.push({ icon: <Shield size={12} />, title: 'Anchor any break on the water', text: `Water is ${z.water_m === 0 ? 'right at the edge' : `${z.water_m} m away`}. Tie a fuel break into the shoreline so fire cannot run around its end.` })
  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-2 hair">
        <Button small minimal icon={<ArrowLeft />} onClick={onBack} />
        <span className="label" style={{ color: ZONE_ORANGE }}>High fire-risk zone</span>
        <span className="ml-auto mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>{z.lat.toFixed(4)}, {z.lon.toFixed(4)}</span>
      </div>
      <div className="scan relative border-b p-4 hair" style={{ background: `linear-gradient(180deg, ${ZONE_ORANGE}26, transparent)` }}>
        <div className="text-base">{place ? `Near ${place}` : `Zone ${z.zid}`}</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Stat label="Area" value={`${z.area_ha.toLocaleString()}`} unit="ha" />
          <Stat label="Homes ≤ 30 m" value={`${z.homes_30m}`} unit="inside or touching" />
          <Stat label="Homes ≤ 500 m" value={`${z.homes_500m}`} unit="nearby" />
        </div>
      </div>
      <Section title="Why it's risky">
        <div className="space-y-2">
          {drivers.map((d) => (
            <div key={d.k}>
              <div className="flex justify-between text-xs">
                <span>{d.k}{d.note && <span style={{ color: 'var(--ops-muted)' }}> · {d.note}</span>}</span>
                <span className="mono" style={{ color: 'var(--ops-muted)' }}>{pct(d.v)}</span>
              </div>
              <ProgressBar value={d.v} stripes={false} animate={false} intent={d.v > 0.5 ? 'danger' : d.v > 0.2 ? 'warning' : 'primary'} className="mt-1" />
            </div>
          ))}
          {note && (
            <p className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>
              <span style={{ color: 'var(--ops-text)' }}>{z.top_fuel}</span> is {note}. {pct((mix.extreme ?? 0) + (mix.high ?? 0))} of the zone is rated High or Extreme by {src.name} ({src.date}).
            </p>
          )}
          <div className="flex justify-between border-t pt-2 text-xs hair">
            <span className="flex items-center gap-1"><Wind size={12} />Dryness today (FFMC {dryness?.ffmc != null ? dryness.ffmc.toFixed(1) : '–'})</span>
            <span className="mono" style={{ color: ff.color }}>{ff.label}</span>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>
            Dryness is one live CWFIS reading for the whole area: it sets how dangerous every zone is today, not where the zones are. The zones come from Ontario forest types and Sentinel-2 leaf-off.
          </p>
        </div>
      </Section>
      <Section title="How to reduce it">
        {steps.length === 0 && <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>No homes nearby; monitor and keep access routes open.</p>}
        <div className="space-y-2">
          {steps.map((st) => (
            <div key={st.title} className="text-xs">
              <div className="flex items-center gap-1.5" style={{ color: '#3dcc91' }}>{st.icon}{st.title}</div>
              <div className="mt-0.5" style={{ color: 'var(--ops-muted)' }}>{st.text}</div>
            </div>
          ))}
        </div>
      </Section>
      <div className="p-3">
        <Button fill intent="danger" large icon={<Flame />} onClick={onIgnite} loading={simulating} className="mono uppercase tracking-widest">
          Simulate fire here
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- High-density home area

export function DensityTab({ d, onBack, onShow, shown }: { d: DensityProps; onBack: () => void; onShow: () => void; shown: boolean }) {
  const place = usePlaceName(d.lon, d.lat)
  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-2 hair">
        <Button small minimal icon={<ArrowLeft />} onClick={onBack} />
        <span className="label" style={{ color: DENSITY_BLUE }}>High-density home area</span>
        <span className="ml-auto mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>{d.lat.toFixed(4)}, {d.lon.toFixed(4)}</span>
      </div>
      <div className="scan relative border-b p-4 hair" style={{ background: `linear-gradient(180deg, ${DENSITY_BLUE}26, transparent)` }}>
        <div className="text-base">{place ? `Near ${place}` : `Area ${d.did}`}</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Stat label="Homes" value={d.homes.toLocaleString()} unit="inside" />
          <Stat label="Area" value={`${d.area_ha.toLocaleString()}`} unit="ha" />
          <Stat label="Density" value={d.homes_per_ha.toFixed(1)} unit="homes / ha" />
        </div>
      </div>
      <Section title="Why it matters">
        <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>
          Homes this close together pass fire to each other once one ignites, and many people need the same roads out. When a simulated fire heads this way,
          the suggested actions put a fuel break or back-burn between the fire and this area and list it first for evacuation.
        </p>
      </Section>
      {!shown && (
        <div className="p-3">
          <Button fill minimal intent="primary" onClick={onShow}>Show all high-density areas on the map</Button>
        </div>
      )}
    </>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mono text-xl leading-tight">{value}</div>
      <div className="text-[10px]" style={{ color: 'var(--ops-muted)' }}>{unit}</div>
    </div>
  )
}

// ---------------------------------------------------------------- Home

interface HomeProps {
  b: BuildingRow
  dryness: Dryness | null
  drynessFactor: number
  weights: { fuel: number; leafoff: number; neighbours: number }
  neighbourCap: number
  cleared: boolean
  onToggleCleared: () => void
  onIgnite: () => void
  onBack: () => void
  simulating: boolean
}

export function HomeTab({ b, dryness, drynessFactor, weights, neighbourCap, cleared, onToggleCleared, onIgnite, onBack, simulating }: HomeProps) {
  const place = usePlaceName(b.lon, b.lat)
  const exposure = cleared ? b.exposure * CLEARED_FACTOR : b.exposure
  const risk = riskOf(exposure, drynessFactor)
  const band = BAND[bandOf(risk)]
  const n = Math.min(b.n_neighbours, neighbourCap) / neighbourCap
  const parts = [
    { k: 'Fuel in 30 m zone', v: b.f_fuel, w: weights.fuel, icon: <Tree size={12} /> },
    { k: 'Fresh leaf litter', v: b.l_leafoff, w: weights.leafoff, icon: <Tree size={12} /> },
    { k: 'Neighbouring structures', v: n, w: weights.neighbours, icon: <Shield size={12} /> },
  ]
  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-2 hair">
        <Button small minimal icon={<ArrowLeft />} onClick={onBack} />
        <span className="truncate text-xs">{place ?? `Home #${b.fid}`}</span>
        <span className="ml-auto mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>{b.lat.toFixed(5)}, {b.lon.toFixed(5)}</span>
      </div>
      <div className="scan relative border-b p-4 hair" style={{ background: `linear-gradient(180deg, ${band.color}22, transparent)` }}>
        <div className="flex items-end gap-4">
          <div>
            <div className="label">Ignition risk today</div>
            <div className="mono text-6xl leading-none" style={{ color: band.color, textShadow: `0 0 24px ${band.color}88` }}>{risk}</div>
          </div>
          <div className="pb-1">
            <Tag intent={band.intent} large className="mono uppercase tracking-widest">{band.label}</Tag>
            <div className="mt-1 text-xs" style={{ color: 'var(--ops-muted)' }}>{band.blurb}</div>
          </div>
        </div>
      </div>
      <Section title="Why" right={<span className="label">weight × value</span>}>
        <div className="space-y-2">
          {parts.map((p) => (
            <div key={p.k}>
              <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1">{p.icon}{p.k}</span>
                <span className="mono" style={{ color: 'var(--ops-muted)' }}>{Math.round(p.w * 100)}% × {p.v.toFixed(2)}</span>
              </div>
              <ProgressBar value={p.v} stripes={false} animate={false} intent={p.v > 0.66 ? 'danger' : p.v > 0.33 ? 'warning' : 'primary'} className="mt-1" />
            </div>
          ))}
          <div className="flex justify-between border-t pt-2 text-xs hair">
            <span className="flex items-center gap-1"><Wind size={12} />Today's dryness (FFMC {dryness?.ffmc != null ? dryness.ffmc.toFixed(1) : '–'})</span>
            <span className="mono" style={{ color: 'var(--ops-muted)' }}>× {drynessMultiplier(drynessFactor).toFixed(2)}</span>
          </div>
          <div className="label pt-1">risk = 100 × exposure {exposure.toFixed(2)} × dryness {drynessMultiplier(drynessFactor).toFixed(2)}</div>
        </div>
      </Section>
      <div className="space-y-2 p-3">
        <Button fill intent="danger" large icon={<Flame />} onClick={onIgnite} loading={simulating} className="mono uppercase tracking-widest">
          Simulate ignition here
        </Button>
        <Button fill minimal={!cleared} intent="success" icon={<Shield />} onClick={onToggleCleared} active={cleared}>
          {cleared ? '30 m zone cleared (undo)' : 'Mark 30 m zone as cleared'}
        </Button>
        <p className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>
          Clearing the Home Ignition Zone (FireSmart 0–30 m) cuts this home's exposure to {Math.round(CLEARED_FACTOR * 100)} % and removes most fuel in the surrounding cells of the fire model.
        </p>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- Simulation

interface SimProps {
  run: SimRun | null
  baseline: SimRun | null
  status: 'idle' | 'running' | 'done'
  t: number
  weather: FbpInputs
  liveWeather: FbpInputs
  windSource: string
  onWeather: (w: FbpInputs | null) => void
  actions: SimActions
  byFid: Map<number, BuildingRow>
  drawingBreak: boolean
  onDrawBreak: () => void
  onClearTop: (n: number) => void
  onResetActions: () => void
  onPick: (b: BuildingRow) => void
  onExit: () => void
  dryness: number
  /** where the fire started, as a place name */
  origin: string
  /** suggestions for this run, or null if not searched yet */
  suggest: SuggestState | null
  onFindSuggestions: () => void
  onApplySuggestion: (s: Suggestion) => void
  water: { share: number; side: string } | null
  /** high-density areas in the order the fire reaches them */
  evacuation: { item: DensityProps; minutes: number | null }[]
  onPickDensity: (did: number) => void
}

export function SimTab(props: SimProps) {
  const { run, baseline, status, t, weather, liveWeather, windSource, onWeather, actions, byFid, drawingBreak, onDrawBreak, onClearTop, onResetActions, onPick, onExit, dryness } = props
  const ign = run ? [...run.ignitedAt.entries()].sort((a, b) => a[1] - b[1]) : []
  const ignitedNow = ign.filter(([, m]) => m <= t).length
  const saved = baseline && run && baseline !== run ? baseline.result.ignitedHomes - run.result.ignitedHomes : 0
  const hasActions = hasAnyAction(actions)
  const [whatIf, setWhatIf] = useState(false)
  const isLive =
    weather.ffmc === liveWeather.ffmc &&
    weather.windKmh === liveWeather.windKmh &&
    weather.windFromDeg === liveWeather.windFromDeg &&
    weather.month === liveWeather.month
  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-2 hair">
        <Flame size={14} style={{ color: 'var(--ops-red)' }} className={status === 'running' ? 'blink' : ''} />
        <span className="mono truncate text-xs">FIRE SPREAD · {run ? `from ${props.origin}` : '…'}</span>
        <Button small minimal icon={<Cross />} className="ml-auto" onClick={onExit} aria-label="End simulation" />
      </div>
      <div className={`grid grid-cols-3 border-b hair ${status === 'running' ? 'sweep' : ''}`}>
        <Big label="Burned" value={run ? `${Math.round(run.result.burnedHa).toLocaleString()}` : '–'} unit="ha / 12 h" />
        <Big label="Homes ignited" value={run ? `${ignitedNow}` : '–'} unit={run ? `of ${run.result.ignitedHomes} by 12 h` : ''} tone="var(--ops-red)" />
        <Big label="Homes saved" value={hasActions && run ? `${saved}` : '–'} unit={hasActions ? 'vs. no action' : 'add an action'} tone="#3dcc91" />
      </div>
      <Section title="Weather driving the run" right={<span className="label" style={isLive ? undefined : { color: 'var(--ops-amber, #f5a623)' }}>{isLive ? windSource : 'what-if · not live'}</span>}>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="mono" style={{ color: 'var(--ops-cyan)' }}>
            FFMC {weather.ffmc.toFixed(0)} · wind {weather.windKmh.toFixed(0)} km/h from {weather.windFromDeg.toFixed(0)}°
          </span>
          <Button small minimal rightIcon={whatIf ? 'chevron-up' : 'chevron-down'} onClick={() => setWhatIf((v) => !v)} aria-expanded={whatIf}>
            What-if weather
          </Button>
        </div>
        {!isLive && !whatIf && (
          <Button small minimal intent="primary" className="mt-1" onClick={() => onWeather(null)}>
            Reset to live
          </Button>
        )}
        {whatIf && (
          <div className="mt-2 rounded border p-2 hair">
            <p className="mb-2 text-[11px]" style={{ color: 'var(--ops-muted)' }}>
              Change the weather to see how the same fire would run. Live today: FFMC {liveWeather.ffmc.toFixed(0)} · {liveWeather.windKmh.toFixed(0)} km/h from {liveWeather.windFromDeg.toFixed(0)}°.
            </p>
            <Knob label="Fine fuel moisture (FFMC)" value={weather.ffmc} min={70} max={96} fmt={(v) => v.toFixed(0)} onChange={(v) => onWeather({ ...weather, ffmc: v })} />
            <Knob label="Wind speed" value={weather.windKmh} min={0} max={50} fmt={(v) => `${v.toFixed(0)} km/h`} onChange={(v) => onWeather({ ...weather, windKmh: v })} />
            <Knob label="Wind from" value={weather.windFromDeg} min={0} max={359} fmt={(v) => `${v.toFixed(0)}°`} onChange={(v) => onWeather({ ...weather, windFromDeg: v })} />
            {!isLive && (
              <Button small minimal intent="primary" onClick={() => onWeather(null)}>
                Reset to live
              </Button>
            )}
          </div>
        )}
        {run && (
          <div className="label pt-1">
            ISI {run.result.isi.toFixed(1)} · fastest fuel {run.result.headRosMPerMin.toFixed(1)} m/min · dryness ×{drynessMultiplier(dryness).toFixed(2)} · solved in {Math.round(run.result.elapsedMs)} ms
          </div>
        )}
      </Section>
      <Suggestions {...props} />
      <Section
        title="Actions"
        right={hasActions ? <Button small minimal intent="danger" onClick={onResetActions}>reset</Button> : undefined}
      >
        <div className="space-y-2">
          <Button fill alignText="left" icon={<Shield />} intent="success" minimal onClick={() => onClearTop(10)} disabled={!run}>
            Clear 30 m zones · next 10 homes in the path
            {actions.cleared.size > 0 && <Tag minimal intent="success" className="mono ml-2">{actions.cleared.size}</Tag>}
          </Button>
          <Button fill alignText="left" icon={<Tree />} intent="success" minimal active={drawingBreak} onClick={onDrawBreak} disabled={!run}>
            {drawingBreak ? 'Click two points on the map…' : 'Cut a fuel break (90 m wide)'}
            {actions.breaks.length > 0 && <Tag minimal intent="success" className="mono ml-2">{actions.breaks.length}</Tag>}
          </Button>
          {(actions.retardant.length > 0 || actions.burnouts.length > 0 || actions.protected.size > 0) && (
            <div className="flex flex-wrap gap-1 text-[11px]" style={{ color: 'var(--ops-muted)' }}>
              {actions.retardant.length > 0 && <Tag minimal className="mono">retardant ×{actions.retardant.length}</Tag>}
              {actions.burnouts.length > 0 && <Tag minimal className="mono">back-burn ×{actions.burnouts.length}</Tag>}
              {actions.protected.size > 0 && <Tag minimal className="mono">sprinklers ×{actions.protected.size}</Tag>}
            </div>
          )}
          <p className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>Every action re-runs the model with the same weather; "Homes saved" compares against the untouched run.</p>
        </div>
      </Section>
      <Section title="Defend first" right={<span className="label">ignites at</span>}>
        {ign.length === 0 && <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>{status === 'running' ? 'Solving…' : 'No homes reached within 12 h.'}</p>}
        {ign.slice(0, 12).map(([fid, m]) => {
          const b = byFid.get(fid)
          if (!b) return null
          return (
            <Row
              key={fid}
              b={b}
              risk={riskOf(b.exposure, dryness)}
              active={false}
              onClick={() => onPick(b)}
              trailing={<span className="mono text-xs" style={{ color: m <= t ? 'var(--ops-red)' : 'var(--ops-muted)' }}>{fmtClock(m)}</span>}
            />
          )
        })}
      </Section>
    </>
  )
}

function Suggestions({ run, status, suggest, onFindSuggestions, onApplySuggestion, water, byFid, evacuation, onPickDensity }: SimProps) {
  const nothingToSave = run != null && run.result.ignitedHomes === 0
  return (
    <Section
      title="Suggested actions"
      right={suggest?.status === 'done' ? <span className="label">{suggest.tested} tried · {(suggest.elapsedMs / 1000).toFixed(1)} s</span> : undefined}
    >
      {water && (
        <p className="mb-2 text-xs">
          <span style={{ color: 'var(--ops-cyan)' }}>Natural barrier: </span>
          water stops {Math.round(water.share * 100)} % of this fire's 12 h edge, mostly on the {water.side} side.
        </p>
      )}
      {nothingToSave && <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>No homes ignite within 12 h, so there is nothing to protect.</p>}
      {!nothingToSave && !suggest && (
        <Button fill intent="primary" icon={<Lightbulb />} onClick={onFindSuggestions} disabled={!run || status === 'running'}>
          Find the best fuel breaks
        </Button>
      )}
      {suggest?.status === 'running' && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ops-muted)' }}>
          <Spinner size={14} /> Re-running the fire with {suggest.tested} options…
        </div>
      )}
      {suggest?.status === 'done' && suggest.items.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>None of the {suggest.tested} breaks or clearings tried saves a home against this fire. Try drawing one by hand.</p>
      )}
      {suggest?.status === 'done' && suggest.items.map((s) => <SuggestionCard key={s.id} s={s} byFid={byFid} onApply={() => onApplySuggestion(s)} />)}
      {run && evacuation.length > 0 && (
        <div className="mt-2">
          <div className="label">Evacuation priority · fire reaches</div>
          {evacuation.slice(0, 4).map((e) => (
            <button key={e.item.did} type="button" onClick={() => onPickDensity(e.item.did)} className="row-hover flex w-full items-center justify-between py-1 text-left text-xs">
              <span><span style={{ color: DENSITY_BLUE }}>●</span> {e.item.homes.toLocaleString()} homes · {e.item.area_ha} ha</span>
              <span className="mono" style={{ color: 'var(--ops-red)' }}>{fmtClock(e.minutes ?? 0)}</span>
            </button>
          ))}
          <p className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>Doesn't change the fire: the high-density areas, in the order the first home in each would ignite.</p>
        </div>
      )}
    </Section>
  )
}

function SuggestionCard({ s, byFid, onApply }: { s: Suggestion; byFid: Map<number, BuildingRow>; onApply: () => void }) {
  const target = s.targetFid != null ? byFid.get(s.targetFid) : undefined
  const place = usePlaceName(target?.lon, target?.lat)
  const km = ((s.lengthM ?? 0) / 1000).toFixed(1)
  const where = `${s.distM} m ${s.side} of ${place ?? 'the first home in its path'}`
  const timing = `The fire reaches this line at ${fmtClock(s.reachMin ?? 0)}; that home would ignite at ${fmtClock(s.homeMin)}.`
  const text: Record<typeof s.kind, [string, string]> = {
    break: [`Cut a 90 m fuel break, ${km} km long`, `${where}. Removes the fuel so the fire stops there. ${timing}`],
    retardant: [`Drop a retardant line, ${km} km long`, `${where}. Slows the fire instead of stopping it, so an aircraft can lay it where crews can't cut in time. ${timing}`],
    burnout: [`Back-burn from ${s.roadName ?? 'the road'}, ${km} km`, `${where}. Uses a road that is already there as the control line, so nothing new has to be cut; crews burn out the fuel on the fire side. ${timing}`],
    protect: [`Sprinklers on the next ${s.clear?.length ?? 0} homes`, `They are the first homes to ignite, from ${fmtClock(s.homeMin)}. Wetting the house and the yard halves how easily it catches, without cutting any vegetation.`],
    clear: [`Clear the 30 m zones of the next ${s.clear?.length ?? 0} homes`, `They are the first homes to ignite, from ${fmtClock(s.homeMin)}. FireSmart 0–30 m clearing removes most of the fuel around each home.`],
  }
  const [title, why] = text[s.kind]
  return (
    <div className="mb-2 rounded-md border p-2 hair">
      <div className="flex items-start gap-2 text-xs">
        <span className="mt-0.5" style={{ color: s.kind === 'retardant' ? '#ff5c5c' : '#3dcc91' }}>{s.kind === 'break' || s.kind === 'burnout' ? <Tree size={12} /> : s.kind === 'retardant' ? <Flame size={12} /> : <Shield size={12} />}</span>
        <span className="flex-1">{title}</span>
        <Tag minimal intent="success" className="mono shrink-0">saves {s.saved}</Tag>
      </div>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--ops-muted)' }}>{why}</p>
      <Button small intent="success" icon={<Tick />} className="mt-1" onClick={onApply}>
        Apply
      </Button>
    </div>
  )
}

function Big({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: string }) {
  return (
    <div className="border-r p-3 last:border-r-0 hair">
      <div className="label">{label}</div>
      <div className="mono text-2xl leading-tight" style={{ color: tone }}>{value}</div>
      <div className="text-[10px]" style={{ color: 'var(--ops-muted)' }}>{unit}</div>
    </div>
  )
}

function Knob({ label, value, min, max, fmt, onChange }: { label: string; value: number; min: number; max: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="mb-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="mono" style={{ color: 'var(--ops-cyan)' }}>{fmt(value)}</span>
      </div>
      <Slider min={min} max={max} stepSize={1} labelRenderer={false} value={value} onChange={onChange} />
    </div>
  )
}
