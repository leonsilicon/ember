import { Button, ProgressBar, Slider, Tag } from '@blueprintjs/core'
import { ArrowLeft, Cross, Flame, Shield, Tree, Wind } from '@blueprintjs/icons'
import { useState, type ReactNode } from 'react'
import type { Dryness } from './live'
import type { FbpInputs } from './sim/fbp'
import { CLEARED_FACTOR } from './sim/protocol'
import type { SimActions, SimRun } from './sim/useSimulation'
import { fmtClock } from './format'
import { BAND, bandOf, drynessMultiplier, riskOf, type Band, type BuildingRow } from './types'

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
  return (
    <button type="button" onClick={onClick} className={`row-hover flex w-full items-center gap-3 border-b px-3 py-2 text-left hair ${active ? 'selected' : ''}`}>
      <span className="h-2 w-2 shrink-0" style={{ background: BAND[bandOf(risk)].color, boxShadow: `0 0 8px ${BAND[bandOf(risk)].color}` }} />
      <span className="flex-1 truncate">
        <span className="mono text-xs" style={{ color: 'var(--ops-muted)' }}>#{b.fid}</span>
        <span className="ml-2 text-xs" style={{ color: 'var(--ops-muted)' }}>{Math.round(b.area_m2)} m² · {b.n_neighbours} nbr</span>
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

// ---------------------------------------------------------------- Homes

interface HomesProps {
  buildings: BuildingRow[]
  dryness: number
  filter: Band | 'all'
  onFilter: (f: Band | 'all') => void
  selected: number | null
  onPick: (b: BuildingRow) => void
}

export function HomesTab({ buildings, dryness, filter, onFilter, selected, onPick }: HomesProps) {
  const risks = buildings.map((b) => riskOf(b.exposure, dryness))
  const counts = { critical: 0, elevated: 0, low: 0 }
  risks.forEach((r) => counts[bandOf(r)]++)
  const rows: { b: BuildingRow; r: number }[] = []
  for (let i = 0; i < buildings.length && rows.length < 300; i++) {
    const band = bandOf(risks[i])
    if (filter === 'all' || band === filter) rows.push({ b: buildings[i], r: risks[i] })
  }
  return (
    <>
      <div className="grid grid-cols-3 border-b hair">
        {(['critical', 'elevated', 'low'] as Band[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onFilter(filter === k ? 'all' : k)}
            className={`row-hover border-r p-3 text-left last:border-r-0 hair ${filter === k ? 'selected' : ''}`}
          >
            <div className="label" style={{ color: BAND[k].color }}>{BAND[k].label}</div>
            <div className="mono text-2xl leading-tight">{counts[k].toLocaleString()}</div>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="label">{filter === 'all' ? 'Highest risk today' : `${BAND[filter].label} homes`} · top {rows.length}</span>
        <span className="label">Risk</span>
      </div>
      <div>
        {rows.map(({ b, r }) => (
          <Row key={b.fid} b={b} risk={r} active={selected === b.fid} onClick={() => onPick(b)} />
        ))}
      </div>
    </>
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
        <span className="mono text-xs" style={{ color: 'var(--ops-muted)' }}>HOME #{b.fid}</span>
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
}

export function SimTab({ run, baseline, status, t, weather, liveWeather, windSource, onWeather, actions, byFid, drawingBreak, onDrawBreak, onClearTop, onResetActions, onPick, onExit, dryness }: SimProps) {
  const ign = run ? [...run.ignitedAt.entries()].sort((a, b) => a[1] - b[1]) : []
  const ignitedNow = ign.filter(([, m]) => m <= t).length
  const saved = baseline && run && baseline !== run ? baseline.result.ignitedHomes - run.result.ignitedHomes : 0
  const hasActions = actions.cleared.size > 0 || actions.breaks.length > 0
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
        <span className="mono text-xs">FIRE SPREAD · {run ? `from #${run.ignitionFid}` : '…'}</span>
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
