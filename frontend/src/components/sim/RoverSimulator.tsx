import { useEffect, useState, type ReactNode } from 'react'
import { formatTime } from '../../sim/controller'
import { DEFAULT_OVERLAYS, PALETTE as C, type Overlays } from '../../sim/overlays'
import { useSimController, useSimVersion } from '../../sim/useSimController'
import { ftToM, SPEEDS, WORK_RADIUS_FT, WORLDS } from '../../sim/worlds'
import { ThreeView } from './ThreeView'
import { TopDownView } from './TopDownView'

const MAX_CAPACITY = 8

const CARD = 'rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5'
const CARD_TITLE = 'text-sm font-semibold text-zinc-100'
const INPUT =
  'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/30'
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'
const SECONDARY = `inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-zinc-800 ${FOCUS}`

/** What each autopilot mode is doing, coloured by phase: looking, closing in, scooping, piling. */
const MODE: Record<string, { label: string; color: string }> = {
  searching: { label: 'Looking for leaves', color: '#a1a1aa' },
  exploring: { label: 'Exploring', color: '#a1a1aa' },
  approaching: { label: 'Driving to a leaf', color: '#60a5fa' },
  aligning: { label: 'Lining up', color: '#60a5fa' },
  scooping: { label: 'Scooping', color: '#4ade80' },
  lifting: { label: 'Into the bin', color: '#4ade80' },
  returning: { label: 'To the pile', color: '#e0953a' },
  dumping: { label: 'Emptying the bin', color: '#e0953a' },
  backing: { label: 'Backing off', color: '#e0953a' },
  checking: { label: 'Double-checking a spot', color: '#7dd3fc' },
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The rover simulator: one RoverSim (rover-brain, on autopilot) drawn twice at once, as a 3D lawn
 * (the main stage) and as the top-down map beside it. The rover starts on the pile and collects the
 * leaves within its work circle, a binful at a time.
 */
export function RoverSimulator() {
  const controller = useSimController()
  useSimVersion(controller)
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS)
  const toggle = (key: keyof Overlays) => setOverlays((o) => ({ ...o, [key]: !o[key] }))
  const placing = controller.placingPile

  // Esc stops placing the pile.
  useEffect(() => {
    if (!placing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') controller.setPlacingPile(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placing, controller])

  const { frame } = controller
  const s = frame.stats
  const step = frame.tick.step
  const time = formatTime(frame.timeMs)
  const done = controller.done
  const mode = step ? (MODE[step.state.mode] ?? { label: step.state.mode, color: '#a1a1aa' }) : null
  const parked = step?.state.mode === 'searching' && step.state.parkedAtMs != null
  // The brain counts the bin empty only once it's done tipping; the leaves are on the pile before that.
  const binLoad = done || step?.state.mode === 'dumping' ? 0 : (step?.state.load ?? 0)
  const inCircle = s.inRange + s.inScoop + s.inPile
  const outside = s.onGround - s.inRange
  const radiusFt = controller.workRadiusFt
  const started = frame.timeMs > 0

  const headline = done ? 'Circle clear' : parked ? 'Parked' : (mode?.label ?? 'Ready')
  const detail = done
    ? `${plural(s.inPile, 'leaf', 'leaves')} on the pile in ${time} of rover time`
    : (step?.message ?? 'Starting on the pile')

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_356px] lg:overflow-hidden lg:p-4">
      <section
        className="relative h-[50vh] min-h-[300px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 lg:h-auto"
        aria-label="3D view"
      >
        <ThreeView controller={controller} overlays={overlays} />
        <div className="pointer-events-none absolute top-3 left-3 w-[min(320px,calc(100%-1.5rem))] rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-2.5 shadow-lg shadow-black/30">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: done ? '#4ade80' : (mode?.color ?? '#a1a1aa') }} />
            <span className="text-sm font-semibold text-zinc-100">{headline}</span>
            <span className="ml-auto pl-3 font-mono text-xs text-zinc-400 tabular-nums">{time}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-400">{detail}</p>
          <div className="mt-2 grid gap-1.5">
            <Gauge label={`${s.inPile}/${inCircle} piled`} count={inCircle} filled={s.inPile} color={C.pile} dot />
            <Gauge label={`Bin ${Math.min(binLoad, controller.capacity)}/${controller.capacity}`} count={controller.capacity} filled={binLoad} color={C.scoopDown} />
          </div>
          {outside > 0 && (
            <p className="mt-1.5 text-[11px] text-zinc-500">
              {plural(outside, 'leaf', 'leaves')} outside the {radiusFt} ft circle, left alone
            </p>
          )}
        </div>
        {placing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-14 flex justify-center px-3">
            <p className="rounded-full border border-amber-400/40 bg-zinc-950/90 px-3.5 py-1.5 text-center text-xs font-medium text-amber-200 shadow-lg shadow-black/30">
              Click the ground to put the pile there. The rover restarts from it. Esc cancels.
            </p>
          </div>
        )}
      </section>

      <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto lg:pr-0.5">
        {/* Run controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => controller.togglePlaying()}
            disabled={done}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-sky-300 disabled:bg-zinc-800 disabled:text-zinc-500 ${FOCUS}`}
          >
            {controller.playing && !done ? <PauseIcon /> : <PlayIcon />}
            {done ? 'Finished' : controller.playing ? 'Pause' : started ? 'Resume' : 'Start'}
          </button>
          <button type="button" onClick={() => controller.reset()} className={`${SECONDARY} py-2.5`} aria-label="Restart from the pile">
            <RestartIcon />
            Restart
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          <span id="sim-speed">Speed</span>
          <div className="flex overflow-hidden rounded-md border border-zinc-800" role="group" aria-labelledby="sim-speed">
            {SPEEDS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={controller.speed === v}
                onClick={() => controller.setSpeed(v)}
                className={`px-2.5 py-1 font-mono tabular-nums ${FOCUS} ${
                  controller.speed === v ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-950 text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                {v}×
              </button>
            ))}
          </div>
        </div>

        {/* Map: also where the pile gets placed */}
        <section
          className={`relative aspect-square shrink-0 overflow-hidden rounded-xl border bg-zinc-950 ${placing ? 'border-amber-400/60' : 'border-zinc-800'}`}
          aria-label="Top view"
        >
          <TopDownView controller={controller} overlays={overlays} />
          <span className="pointer-events-none absolute top-2 left-2 rounded bg-zinc-950/80 px-1.5 py-0.5 text-[11px] font-medium text-zinc-400">
            {placing ? 'Click to put the pile here' : 'Top view · 1 m grid'}
          </span>
        </section>

        {/* The job: the settings that change what the rover does */}
        <section className={CARD} aria-labelledby="sim-job">
          <h3 id="sim-job" className={CARD_TITLE}>
            The job
          </h3>
          <p className="mt-1 text-[13px] leading-snug text-zinc-300">
            Starts at the pile and collects every leaf within <Em>{radiusFt} ft</Em>, bringing them back{' '}
            <Em>{controller.capacity === 1 ? 'one at a time' : `${controller.capacity} at a time`}</Em>.
          </p>

          <div className="mt-3.5 flex flex-col gap-4 text-xs text-zinc-300">
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor="sim-radius" className="font-medium text-zinc-200">
                  Work circle
                </label>
                <span className="font-mono text-zinc-300 tabular-nums">
                  {radiusFt} ft <span className="text-zinc-500">· {ftToM(radiusFt).toFixed(2)} m</span>
                </span>
              </div>
              <input
                id="sim-radius"
                type="range"
                min={WORK_RADIUS_FT.min}
                max={WORK_RADIUS_FT.max}
                step={1}
                value={radiusFt}
                aria-valuetext={`${radiusFt} feet`}
                onChange={(e) => controller.setWorkRadiusFt(Number(e.target.value))}
                className="mt-2 w-full accent-sky-300"
              />
              <p className="mt-0.5 text-[11px] text-zinc-500">The dashed circle round the pile. Leaves outside it are left alone.</p>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2">
                <span id="sim-capacity" className="font-medium text-zinc-200">
                  Leaves per trip
                </span>
                <div className="flex items-center overflow-hidden rounded-md border border-zinc-700" role="group" aria-labelledby="sim-capacity">
                  <StepButton label="Fewer leaves per trip" disabled={controller.capacity <= 1} onClick={() => controller.setCapacity(controller.capacity - 1)}>
                    <MinusIcon />
                  </StepButton>
                  <output aria-live="polite" className="w-8 text-center font-mono text-sm text-zinc-100 tabular-nums">
                    {controller.capacity}
                  </output>
                  <StepButton label="More leaves per trip" disabled={controller.capacity >= MAX_CAPACITY} onClick={() => controller.setCapacity(controller.capacity + 1)}>
                    <PlusIcon />
                  </StepButton>
                </div>
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">Each scoop tips into the bin; a full bin goes to the pile.</p>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-zinc-200">Pile</span>
                <span className="font-mono text-zinc-400 tabular-nums">
                  {controller.pileOverride ? `${frame.pile!.center[0].toFixed(1)}, ${frame.pile!.center[2].toFixed(1)} m` : 'yard centre'}
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  aria-pressed={placing}
                  onClick={() => controller.setPlacingPile(!placing)}
                  className={
                    placing
                      ? `inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-300 ${FOCUS}`
                      : `${SECONDARY} flex-1`
                  }
                >
                  <PinIcon />
                  {placing ? 'Cancel' : 'Move pile'}
                </button>
                <button type="button" className={`${SECONDARY} flex-1`} disabled={!controller.pileOverride} onClick={() => controller.resetPile()}>
                  Back to centre
                </button>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">The rover starts on the pile. Moving it restarts the run.</p>
            </div>
          </div>
        </section>

        <section className={CARD} aria-labelledby="sim-run">
          <h3 id="sim-run" className={CARD_TITLE}>
            This run
          </h3>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            <Row label="Left in the circle">{s.inRange}</Row>
            <Row label="Outside the circle">{outside}</Row>
            <Row label="Scoops emptied on the pile">{s.dumped}</Row>
            <Row label="Collisions">{s.collisions}</Row>
          </dl>
        </section>

        <section className={CARD} aria-labelledby="sim-yard">
          <h3 id="sim-yard" className={CARD_TITLE}>
            Yard
          </h3>
          <div className="mt-2.5 flex flex-col gap-2.5 text-xs text-zinc-300">
            <label className="flex items-center justify-between gap-2">
              Layout
              <select className={`${INPUT} max-w-[170px]`} value={controller.worldName} onChange={(e) => controller.setWorld(e.target.value)}>
                {Object.keys(WORLDS).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 accent-sky-400" checked={controller.noisy} onChange={(e) => controller.setNoisy(e.target.checked)} />
              <span>
                Harsh sensors
                <span className="block text-[11px] text-zinc-500">False sightings, noisier positions, a scoop that misses 30% of the time</span>
              </span>
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>
                Random seed <span className="text-zinc-500">(same seed, same run)</span>
              </span>
              <input
                type="number"
                className={`${INPUT} w-20 text-right tabular-nums`}
                defaultValue={controller.seed}
                onChange={(e) => controller.setSeed(Number(e.target.value) || 1)}
              />
            </label>
          </div>
        </section>

        <details className={`${CARD} group`}>
          <summary className={`flex cursor-pointer list-none items-center justify-between rounded ${CARD_TITLE} ${FOCUS}`}>
            Map layers
            <ChevronIcon />
          </summary>
          <ul className="mt-2.5 flex flex-col gap-1.5 text-xs text-zinc-300">
            <Legend swatch={<Dot color={C.leaf} />}>Leaf on the ground</Legend>
            <Legend swatch={<Dot color={C.leafPiled} />}>Leaf in the pile</Legend>
            <Legend swatch={<Dot color={C.obstacle} />}>Trunk / rock</Legend>
            <Legend swatch={<Dash color={C.work} />}>Work circle</Legend>
            <Legend swatch={<Bar color={C.scoopDown} />}>Scoop down</Legend>
            <Toggle checked={overlays.belief} onChange={() => toggle('belief')} swatch={<Ring color={C.belief} />}>
              Leaves the rover has seen (bold = target)
            </Toggle>
            <Toggle checked={overlays.corridors} onChange={() => toggle('corridors')} swatch={<Bar color="#4ade80" />}>
              Clear paths (<span className="text-red-400">red</span> = blocked)
            </Toggle>
            <Toggle checked={overlays.fov} onChange={() => toggle('fov')} swatch={<Bar color="rgba(96,165,250,.35)" />}>
              Camera view
            </Toggle>
            <Toggle checked={overlays.trail} onChange={() => toggle('trail')} swatch={<Bar color={C.belief} />}>
              Trail
            </Toggle>
          </ul>
          <p className="mt-2.5 text-[11px] text-zinc-500">Drag a leaf in either view to move it. The rover only finds out when its camera sees it.</p>
        </details>

        <p className="px-1 pb-1 text-[11px] leading-snug text-zinc-500">
          This runs the rover's own brain (<span className="font-mono">rover-brain</span>), the same code the phone uses to drive the real rover.
        </p>
      </aside>
    </div>
  )
}

/** A row of cells, one per item, the first `filled` coloured in. */
function Gauge({ label, count, filled, color, dot }: { label: string; count: number; filled: number; color: string; dot?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-wrap gap-0.5" aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className={`inline-block ${dot ? 'h-2 w-2 rounded-full' : 'h-2 w-3 rounded-sm'}`}
            style={{ background: i < filled ? color : '#3f3f46' }}
          />
        ))}
      </div>
      <span className="text-xs whitespace-nowrap text-zinc-300 tabular-nums">{label}</span>
    </div>
  )
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center bg-zinc-950 text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-zinc-950 ${FOCUS}`}
    >
      {children}
    </button>
  )
}

const Em = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-sky-200">{children}</strong>

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-mono text-zinc-200 tabular-nums">{children}</dd>
    </>
  )
}

function Legend({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="w-[13px]" />
      <span className="flex w-4 justify-center">{swatch}</span>
      <span>{children}</span>
    </li>
  )
}

function Toggle({ checked, onChange, swatch, children }: { checked: boolean; onChange: () => void; swatch: ReactNode; children: ReactNode }) {
  return (
    <li>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-sky-400" checked={checked} onChange={onChange} />
        <span className="flex w-4 justify-center">{swatch}</span>
        <span>{children}</span>
      </label>
    </li>
  )
}

const Dot = ({ color }: { color: string }) => <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
const Bar = ({ color }: { color: string }) => <span className="inline-block h-1 w-4 rounded" style={{ background: color }} />
const Ring = ({ color }: { color: string }) => <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: color }} />
const Dash = ({ color }: { color: string }) => <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: color }} />

/** Icons: 16px, 2px stroke, round caps (lucide geometry). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}
const PlayIcon = () => (
  <Icon>
    <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
  </Icon>
)
const PauseIcon = () => (
  <Icon>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
  </Icon>
)
const RestartIcon = () => (
  <Icon>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
)
const MinusIcon = () => (
  <Icon>
    <path d="M5 12h14" />
  </Icon>
)
const PlusIcon = () => (
  <Icon>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Icon>
)
const PinIcon = () => (
  <Icon>
    <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
    <circle cx="12" cy="10" r="3" />
  </Icon>
)
const ChevronIcon = () => (
  <span className="text-zinc-500 transition-transform group-open:rotate-180">
    <Icon>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  </span>
)
