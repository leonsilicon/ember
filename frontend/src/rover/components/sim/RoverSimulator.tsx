import { useEffect, useState, type ReactNode } from 'react'
import { formatTime } from '../../sim/controller'
import { DEFAULT_OVERLAYS, PALETTE as C, type Overlays } from '../../sim/overlays'
import { useSimController, useSimVersion } from '../../sim/useSimController'
import { ftToM, SPEEDS, WORK_RADIUS_FT, WORLDS } from '../../sim/worlds'
import { Button, Field, Hint, IconButton, Icons, INPUT, Led, Meter, Readout, Segmented } from '../../ui/kit'
import { Module } from '../../ui/layout'
import { isShortcutEvent, Shell, type Shortcut } from '../../ui/Shell'
import { ThreeView, VIEW_SHORTCUTS } from './ThreeView'
import { TopDownView } from './TopDownView'

const MAX_CAPACITY = 8

/** What each autopilot mode is doing, coloured by phase: looking, closing in, scooping, piling. */
const MODE: Record<string, { label: string; color: string }> = {
  searching: { label: 'Looking for leaves', color: 'var(--ink-3)' },
  exploring: { label: 'Exploring', color: 'var(--ink-3)' },
  approaching: { label: 'Driving to a leaf', color: 'var(--info)' },
  aligning: { label: 'Lining up', color: 'var(--info)' },
  scooping: { label: 'Scooping', color: 'var(--ok)' },
  lifting: { label: 'Into the bin', color: 'var(--ok)' },
  returning: { label: 'To the pile', color: C.pile },
  dumping: { label: 'Emptying the bin', color: C.pile },
  backing: { label: 'Backing off', color: C.pile },
  checking: { label: 'Double-checking a spot', color: 'var(--info)' },
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['Space'], label: 'Start or pause' },
  { keys: ['R'], label: 'Restart from the pile' },
  { keys: SPEEDS.map((_, i) => String(i + 1)), label: `Speed ${SPEEDS.map((v) => `${v}×`).join(' / ')}` },
  { keys: ['P'], label: 'Move the pile (Esc cancels)' },
  ...VIEW_SHORTCUTS,
]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The rover simulator: one RoverSim (rover-brain, on autopilot) drawn twice at once, as a 3D lawn
 * (the stage) and as the top-down map in the rail. The rover starts on the pile and collects the
 * leaves within its work circle, a binful at a time.
 */
export function RoverSimulator() {
  const controller = useSimController()
  useSimVersion(controller)
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS)
  const toggle = (key: keyof Overlays) => setOverlays((o) => ({ ...o, [key]: !o[key] }))
  const placing = controller.placingPile

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && controller.placingPile) return controller.setPlacingPile(false)
      if (!isShortcutEvent(e)) return
      const speed = Number(e.key)
      if (e.key === ' ') {
        if (!controller.done) controller.togglePlaying()
      } else if (e.key === 'r' || e.key === 'R') controller.reset()
      else if (e.key === 'p' || e.key === 'P') controller.setPlacingPile(!controller.placingPile)
      else if (Number.isInteger(speed) && speed >= 1 && speed <= SPEEDS.length) controller.setSpeed(SPEEDS[speed - 1])
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller])

  const { frame } = controller
  const s = frame.stats
  const step = frame.tick.step
  const time = formatTime(frame.timeMs)
  const done = controller.done
  const mode = step ? (MODE[step.state.mode] ?? { label: step.state.mode, color: 'var(--ink-3)' }) : null
  const parked = step?.state.mode === 'searching' && step.state.parkedAtMs != null
  // The brain counts the bin empty only once it's done tipping; the leaves are on the pile before that.
  const binLoad = done || step?.state.mode === 'dumping' ? 0 : (step?.state.load ?? 0)
  const inCircle = s.inRange + s.inScoop + s.inPile
  const outside = s.onGround - s.inRange
  const radiusFt = controller.workRadiusFt
  const started = frame.timeMs > 0
  const running = controller.playing && !done

  const headline = done ? 'Circle clear' : parked ? 'Parked' : (mode?.label ?? 'Ready')
  const detail = done
    ? `${plural(s.inPile, 'leaf', 'leaves')} on the pile in ${time} of rover time`
    : (step?.message ?? 'Starting on the pile')
  const statusWord = done ? 'Finished' : running ? 'Running' : started ? 'Paused' : 'Ready'

  const stage = (
    <>
      <ThreeView controller={controller} overlays={overlays} />

      {/* Status readout: what the rover is doing, always the loudest thing on screen. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute top-3 left-3 w-[min(320px,calc(100%-7.5rem))] rounded-[10px] border border-line bg-panel/95 px-3.5 py-3 shadow-float backdrop-blur-sm"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={{ background: done ? 'var(--ok)' : (mode?.color ?? 'var(--ink-3)') }} />
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{headline}</span>
          <span className="num ml-auto pl-3 text-xs text-ink-2">{time}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-ink-2">{detail}</p>
        <div className="mt-3 grid gap-2">
          <Meter count={inCircle} filled={s.inPile} color={C.pile} label={`${s.inPile}/${inCircle} piled`} />
          <Meter count={controller.capacity} filled={binLoad} color="var(--ok)" label={`bin ${Math.min(binLoad, controller.capacity)}/${controller.capacity}`} />
        </div>
        {outside > 0 && <p className="mt-2 text-[11px] text-ink-3">{plural(outside, 'leaf', 'leaves')} outside the {radiusFt} ft circle, left alone</p>}
      </div>

      {placing && (
        <p className="pointer-events-none absolute inset-x-3 bottom-[4.25rem] mx-auto w-fit max-w-full rounded-full border border-ember bg-panel px-3.5 py-1.5 text-center text-xs font-medium text-ink shadow-float">
          Click the ground to put the pile there. The rover restarts from it. <span className="text-ink-3">Esc cancels.</span>
        </p>
      )}

      {/* Transport */}
      <div className="absolute inset-x-3 bottom-3 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-xl border border-line bg-panel/95 p-1.5 shadow-float backdrop-blur-sm">
        <Button variant="primary" size="lg" onClick={() => controller.togglePlaying()} disabled={done} className="px-3 sm:min-w-[7.5rem]" aria-keyshortcuts="Space">
          {running ? <Icons.pause /> : <Icons.play />}
          {done ? 'Finished' : running ? 'Pause' : started ? 'Resume' : 'Start'}
        </Button>
        <IconButton label="Restart from the pile (R)" onClick={() => controller.reset()} className="h-10 w-10">
          <Icons.restart />
        </IconButton>
        <span aria-hidden className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <Segmented label="Speed" options={SPEEDS} value={controller.speed} onChange={(v) => controller.setSpeed(v)} render={(v) => <span className="num">{v}×</span>} className="[&>button]:px-2 sm:[&>button]:px-2.5" />
      </div>
    </>
  )

  const modules = (
    <>
      <Module id="map" title="Top view" meta={placing ? 'placing pile' : '1 m grid'} flush>
        <div className={`relative aspect-square ${placing ? 'outline-2 -outline-offset-2 outline-ember' : ''}`}>
          <TopDownView controller={controller} overlays={overlays} />
          {placing && (
            <span className="pointer-events-none absolute top-2 left-2 rounded-md bg-ember px-2 py-0.5 text-[11px] font-medium text-[#1c1917]">Click to put the pile here</span>
          )}
        </div>
      </Module>

      <Module id="job" title="Job" meta={`${radiusFt} ft · ${controller.capacity}/trip`}>
        <p className="text-[13px] leading-relaxed text-ink-2">
          Starts at the pile and collects every leaf within <Em>{radiusFt} ft</Em>, bringing them back{' '}
          <Em>{controller.capacity === 1 ? 'one at a time' : `${controller.capacity} at a time`}</Em>.
        </p>
        <div className="mt-4 flex flex-col gap-5">
          <Field
            label="Work circle"
            htmlFor="sim-radius"
            value={
              <span className="num text-[13px] text-ink">
                {radiusFt} ft <span className="text-ink-3">· {ftToM(radiusFt).toFixed(2)} m</span>
              </span>
            }
            hint="The dashed circle round the pile. Leaves outside it are left alone."
          >
            <input
              id="sim-radius"
              type="range"
              min={WORK_RADIUS_FT.min}
              max={WORK_RADIUS_FT.max}
              step={1}
              value={radiusFt}
              aria-valuetext={`${radiusFt} feet`}
              onChange={(e) => controller.setWorkRadiusFt(Number(e.target.value))}
              className="w-full"
            />
          </Field>

          <Field
            label={<span id="sim-capacity">Leaves per trip</span>}
            value={
              <div className="flex items-center rounded-md border border-line bg-well" role="group" aria-labelledby="sim-capacity">
                <StepButton label="Fewer leaves per trip" disabled={controller.capacity <= 1} onClick={() => controller.setCapacity(controller.capacity - 1)}>
                  <Icons.minus />
                </StepButton>
                <output aria-live="polite" className="num w-8 text-center text-[13px] text-ink">
                  {controller.capacity}
                </output>
                <StepButton label="More leaves per trip" disabled={controller.capacity >= MAX_CAPACITY} onClick={() => controller.setCapacity(controller.capacity + 1)}>
                  <Icons.plus />
                </StepButton>
              </div>
            }
            hint="Each scoop tips into the bin; a full bin goes to the pile."
          />

          <Field
            label="Pile"
            value={
              <span className="num text-[13px] text-ink-2">
                {controller.pileOverride ? `${frame.pile!.center[0].toFixed(1)}, ${frame.pile!.center[2].toFixed(1)} m` : 'yard centre'}
              </span>
            }
            hint="The rover starts on the pile. Moving it restarts the run."
          >
            <div className="flex gap-2">
              <Button
                variant={placing ? 'primary' : 'secondary'}
                aria-pressed={placing}
                aria-keyshortcuts="P"
                onClick={() => controller.setPlacingPile(!placing)}
                className="flex-1"
              >
                <Icons.pin />
                {placing ? 'Cancel' : 'Move pile'}
              </Button>
              <Button className="flex-1" disabled={!controller.pileOverride} onClick={() => controller.resetPile()}>
                Back to centre
              </Button>
            </div>
          </Field>
        </div>
      </Module>

      <Module id="run" title="This run" meta={`${s.inPile} piled`}>
        <dl>
          <Readout label="Left in the circle">{s.inRange}</Readout>
          <Readout label="Outside the circle">{outside}</Readout>
          <Readout label="Scoops emptied on the pile">{s.dumped}</Readout>
          <Readout label="Collisions" tone={s.collisions > 0 ? 'danger' : undefined}>
            {s.collisions}
          </Readout>
        </dl>
      </Module>

      <Module id="yard" title="Yard" meta={controller.worldName}>
        <div className="flex flex-col gap-4">
          <Field label="Layout" htmlFor="sim-world">
            <select id="sim-world" className={`${INPUT} w-full`} value={controller.worldName} onChange={(e) => controller.setWorld(e.target.value)}>
              {Object.keys(WORLDS).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={controller.noisy} onChange={(e) => controller.setNoisy(e.target.checked)} />
            <span>
              <span className="text-[13px] font-medium text-ink">Harsh sensors</span>
              <Hint className="mt-0.5">False sightings, noisier positions, a scoop that misses 30% of the time</Hint>
            </span>
          </label>
          <Field label="Random seed" htmlFor="sim-seed" hint="Same seed, same run.">
            <input
              id="sim-seed"
              type="number"
              inputMode="numeric"
              className={`${INPUT} num w-full`}
              defaultValue={controller.seed}
              onChange={(e) => controller.setSeed(Number(e.target.value) || 1)}
            />
          </Field>
        </div>
      </Module>

      <Module id="layers" title="Map layers" defaultState="collapsed">
        <ul className="flex flex-col gap-2 text-[13px] text-ink-2">
          <Legend swatch={<Dot color={C.leaf} />}>Leaf on the ground</Legend>
          <Legend swatch={<Dot color={C.leafPiled} />}>Leaf in the pile</Legend>
          <Legend swatch={<Dot color={C.obstacle} />}>Trunk / rock</Legend>
          <Legend swatch={<Dash color="var(--map-work)" />}>Work circle</Legend>
          <Legend swatch={<Bar color={C.scoopDown} />}>Scoop down</Legend>
          <li aria-hidden className="my-1 h-px bg-line" />
          <Toggle checked={overlays.belief} onChange={() => toggle('belief')} swatch={<Ring color={C.belief} />}>
            Leaves the rover has seen (bold = target)
          </Toggle>
          <Toggle checked={overlays.corridors} onChange={() => toggle('corridors')} swatch={<Bar color="#4ade80" />}>
            Clear paths (<span className="text-danger">red</span> = blocked)
          </Toggle>
          <Toggle checked={overlays.fov} onChange={() => toggle('fov')} swatch={<Bar color="rgba(96,165,250,.45)" />}>
            Camera view
          </Toggle>
          <Toggle checked={overlays.trail} onChange={() => toggle('trail')} swatch={<Bar color={C.belief} />}>
            Trail
          </Toggle>
        </ul>
        <Hint className="mt-3">Drag a leaf in either view to move it. The rover only finds out when its camera sees it.</Hint>
      </Module>
    </>
  )

  return (
    <Shell
      page="/sim"
      shortcuts={SHORTCUTS}
      status={
        <span className="hidden items-center gap-2 text-[13px] text-ink-2 md:flex">
          <Led tone={done ? 'ok' : running ? 'live' : 'off'} />
          <span className="text-ink">{statusWord}</span>
          <span className="num text-ink-3">{time}</span>
        </span>
      }
      stage={stage}
      modules={modules}
      railFooter={
        <p className="px-1 pt-1 pb-2 text-[11px] leading-snug text-ink-3">
          This runs the rover's own brain (<span className="num">rover-brain</span>), the same code the phone uses to drive the real rover.
        </p>
      }
    />
  )
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-[5px] text-ink-2 transition-colors hover:bg-panel hover:text-ink disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  )
}

const Em = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-ink">{children}</strong>

function Legend({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="w-4" />
      <span className="flex w-4 justify-center">{swatch}</span>
      <span>{children}</span>
    </li>
  )
}

function Toggle({ checked, onChange, swatch, children }: { checked: boolean; onChange: () => void; swatch: ReactNode; children: ReactNode }) {
  return (
    <li>
      <label className="flex items-center gap-2.5">
        <input type="checkbox" className="h-4 w-4" checked={checked} onChange={onChange} />
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
