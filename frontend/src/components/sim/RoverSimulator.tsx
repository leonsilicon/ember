import { useState, type ReactNode } from 'react'
import { formatTime } from '../../sim/controller'
import { DEFAULT_OVERLAYS, PALETTE as C, type Overlays } from '../../sim/overlays'
import { useSimController, useSimVersion } from '../../sim/useSimController'
import { SPEEDS, WORLDS } from '../../sim/worlds'
import { ThreeView } from './ThreeView'
import { TopDownView } from './TopDownView'

const CARD = 'rounded-xl border border-zinc-800 bg-zinc-900/60 p-3'
const CARD_TITLE = 'mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase'
const INPUT =
  'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/30'
const BUTTON =
  'flex-1 rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400'

/** What each autopilot mode is doing, coloured by phase: looking, closing in, scooping, piling. */
const MODE: Record<string, { label: string; color: string }> = {
  searching: { label: 'Searching', color: '#a1a1aa' },
  exploring: { label: 'Exploring', color: '#a1a1aa' },
  approaching: { label: 'Approaching', color: '#60a5fa' },
  aligning: { label: 'Lining up', color: '#60a5fa' },
  scooping: { label: 'Scooping', color: '#4ade80' },
  lifting: { label: 'Lifting', color: '#4ade80' },
  returning: { label: 'To the pile', color: '#e0953a' },
  dumping: { label: 'Dumping', color: '#e0953a' },
  backing: { label: 'Backing off', color: '#e0953a' },
}

/**
 * The rover simulator: one RoverSim (rover-brain, on autopilot) drawn twice at once, as a 3D lawn
 * (the main stage) and as the top-down map beside it. Both read the same running sim.
 */
export function RoverSimulator() {
  const controller = useSimController()
  useSimVersion(controller)
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS)
  const toggle = (key: keyof Overlays) => setOverlays((o) => ({ ...o, [key]: !o[key] }))

  const { frame } = controller
  const s = frame.stats
  const step = frame.tick.step
  const time = formatTime(frame.timeMs)
  const done = controller.done
  const mode = step ? (MODE[step.state.mode] ?? { label: step.state.mode, color: '#a1a1aa' }) : null

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden lg:p-4">
      <section
        className="relative h-[50vh] min-h-[300px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 lg:h-auto"
        aria-label="3D view"
      >
        <ThreeView controller={controller} overlays={overlays} />
        <div className="pointer-events-none absolute top-3 left-3 max-w-[calc(100%-1.5rem)] rounded-lg border border-zinc-800 bg-zinc-950/85 px-3 py-2 shadow-lg shadow-black/30">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: done ? '#4ade80' : (mode?.color ?? '#a1a1aa') }}
            />
            <span className="text-sm font-semibold text-zinc-100">{done ? 'All leaves piled' : (mode?.label ?? 'Ready')}</span>
            <span className="ml-auto pl-3 font-mono text-xs text-zinc-400 tabular-nums">{time}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-400">{done ? `Finished in ${time} of rover time` : (step?.message ?? 'Starting')}</p>
          <LeafTally piled={s.inPile} total={frame.leaves.length} carried={s.inScoop} />
        </div>
      </section>

      <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
        <section className="relative aspect-square shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950" aria-label="Top view">
          <TopDownView controller={controller} overlays={overlays} />
          <span className="pointer-events-none absolute top-2 left-2 rounded bg-zinc-950/80 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
            Top view · 1 m grid
          </span>
        </section>

        <section className={CARD}>
          <div className="mb-2 flex gap-2">
            <button type="button" className={BUTTON} onClick={() => controller.togglePlaying()}>
              {controller.playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className={BUTTON} onClick={() => controller.reset()}>
              Restart
            </button>
          </div>
          <div className="flex flex-col gap-2 text-xs text-zinc-300">
            <label className="flex items-center justify-between gap-2">
              Yard
              <select className={`${INPUT} max-w-[170px]`} value={controller.worldName} onChange={(e) => controller.setWorld(e.target.value)}>
                {Object.keys(WORLDS).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center justify-between gap-2">
              <span id="sim-speed">Speed</span>
              <div className="flex overflow-hidden rounded-md border border-zinc-700" role="group" aria-labelledby="sim-speed">
                {SPEEDS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={controller.speed === v}
                    onClick={() => controller.setSpeed(v)}
                    className={`px-2 py-0.5 font-mono tabular-nums focus-visible:outline-2 focus-visible:outline-sky-400 ${
                      controller.speed === v ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-950 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    {v}×
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between gap-2">
              Seed
              <input
                type="number"
                className={`${INPUT} w-20 text-right tabular-nums`}
                defaultValue={controller.seed}
                onChange={(e) => controller.setSeed(Number(e.target.value) || 1)}
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-sky-500" checked={controller.noisy} onChange={(e) => controller.setNoisy(e.target.checked)} />
              Harsh sensors <span className="text-zinc-500">(false sightings, noise, 70% scoop)</span>
            </label>
          </div>
        </section>

        <section className={CARD}>
          <h3 className={CARD_TITLE}>Run</h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            <Row label="Still on the ground">{s.onGround}</Row>
            <Row label="Scoop">{`${frame.scoop}${s.inScoop ? ` · ${s.inScoop} leaf` : ''}`}</Row>
            <Row label="Trips to the pile">{s.dumped}</Row>
            <Row label="Collisions">{s.collisions}</Row>
            <Row label="Wheels L / R">{step ? `${step.left.toFixed(0)} / ${step.right.toFixed(0)}` : '0 / 0'}</Row>
          </dl>
        </section>

        <section className={CARD}>
          <h3 className={CARD_TITLE}>Layers</h3>
          <ul className="flex flex-col gap-1.5 text-xs text-zinc-300">
            <Legend swatch={<Dot color={C.leaf} />}>Leaf on the ground</Legend>
            <Legend swatch={<Dot color={C.leafPiled} />}>Leaf in the pile</Legend>
            <Legend swatch={<Dot color={C.obstacle} />}>Trunk / rock</Legend>
            <Legend swatch={<Bar color={C.scoopDown} />}>Scoop down</Legend>
            <Toggle checked={overlays.belief} onChange={() => toggle('belief')} swatch={<Ring color={C.belief} />}>
              Brain's leaf map (bold = target)
            </Toggle>
            <Toggle checked={overlays.corridors} onChange={() => toggle('corridors')} swatch={<Bar color="#4ade80" />}>
              Corridors (<span className="text-red-400">red</span> = blocked)
            </Toggle>
            <Toggle checked={overlays.fov} onChange={() => toggle('fov')} swatch={<Bar color="rgba(96,165,250,.35)" />}>
              Camera view
            </Toggle>
            <Toggle checked={overlays.trail} onChange={() => toggle('trail')} swatch={<Bar color={C.belief} />}>
              Trail
            </Toggle>
            <Toggle checked={overlays.pileZone} onChange={() => toggle('pileZone')} swatch={<Ring color={C.pile} />}>
              Pile zone
            </Toggle>
            <Toggle checked={overlays.litter} onChange={() => toggle('litter')} swatch={<Dot color="#6b4a2a" />}>
              Decorative litter (3D)
            </Toggle>
          </ul>
          <p className="mt-2 text-[11px] text-zinc-500">Drag a leaf in either view to move it. The rover only learns of it when its camera sees it.</p>
        </section>
      </aside>
    </div>
  )
}

/** One dot per leaf: piled ones filled, the rest outlined, so progress reads at a glance. */
function LeafTally({ piled, total, carried }: { piled: number; total: number; carried: number }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex flex-wrap gap-1" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="inline-block h-2 w-2 rounded-full border"
            style={
              i < piled
                ? { background: C.pile, borderColor: C.pile }
                : i < piled + carried
                  ? { background: C.scoopDown, borderColor: C.scoopDown }
                  : { borderColor: '#52525b' }
            }
          />
        ))}
      </div>
      <span className="text-xs text-zinc-300 tabular-nums">
        {piled}/{total} in the pile
      </span>
    </div>
  )
}

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

function Toggle({
  checked,
  onChange,
  swatch,
  disabled,
  children,
}: {
  checked: boolean
  onChange: () => void
  swatch: ReactNode
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <li>
      <label className={`flex items-center gap-2 ${disabled ? 'opacity-50' : ''}`}>
        <input type="checkbox" className="accent-sky-500" checked={checked} onChange={onChange} disabled={disabled} />
        <span className="flex w-4 justify-center">{swatch}</span>
        <span>{children}</span>
      </label>
    </li>
  )
}

const Dot = ({ color }: { color: string }) => <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
const Bar = ({ color }: { color: string }) => <span className="inline-block h-1 w-4 rounded" style={{ background: color }} />
const Ring = ({ color }: { color: string }) => <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: color }} />
