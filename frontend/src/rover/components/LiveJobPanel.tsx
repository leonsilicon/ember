import type { LiveMap } from '@rover-brain'
import type { ReactNode } from 'react'
import { MAX_CAPACITY, type LiveJob } from '../liveJob'
import { ftToM, WORK_RADIUS_FT } from '../sim/worlds'
import { Button, Field, Icons } from '../ui/kit'
import { Module } from '../ui/layout'

type Props = {
  job: LiveJob
  onChange: (job: LiveJob) => void
  /** The phone's own map (before the job), for its pile and the rover's position. */
  map: LiveMap | null
  placing: boolean
  onPlacing: (placing: boolean) => void
}

/**
 * The live rover's job, set here like the simulator's: the work circle round the pile, leaves per
 * trip, and where the pile is (clicked on the live map, at the rover, or the one set on the phone).
 * The web autopilot works to it; changes apply on its next step, even mid-run.
 */
export function LiveJobPanel({ job, onChange, map, placing, onPlacing }: Props) {
  const rover = map?.rover ?? null
  const phonePile = map?.pile ?? null
  const set = (patch: Partial<LiveJob>) => onChange({ ...job, ...patch })
  const pileText = job.pile ? `${job.pile.x.toFixed(1)}, ${job.pile.z.toFixed(1)} m` : phonePile ? "phone's pile" : 'not set'

  return (
    <Module id="job" title="Job" meta={`${job.radiusFt} ft · ${job.capacity}/trip`}>
      <p className="text-[13px] leading-relaxed text-ink-2">
        Collects every leaf within <Em>{job.radiusFt} ft</Em> of the pile, bringing them back{' '}
        <Em>{job.capacity === 1 ? 'one at a time' : `${job.capacity} at a time`}</Em>.
      </p>
      <div className="mt-4 flex flex-col gap-5">
        <Field
          label="Work circle"
          htmlFor="live-radius"
          value={
            <span className="num text-[13px] text-ink">
              {job.radiusFt} ft <span className="text-ink-3">· {ftToM(job.radiusFt).toFixed(2)} m</span>
            </span>
          }
          hint="The dashed circle round the pile. Leaves outside it are left alone."
        >
          <input
            id="live-radius"
            type="range"
            min={WORK_RADIUS_FT.min}
            max={WORK_RADIUS_FT.max}
            step={1}
            value={job.radiusFt}
            aria-valuetext={`${job.radiusFt} feet`}
            onChange={(e) => set({ radiusFt: Number(e.target.value) })}
            className="w-full"
          />
        </Field>

        <Field
          label={<span id="live-capacity">Leaves per trip</span>}
          value={
            <div className="flex items-center rounded-md border border-line bg-well" role="group" aria-labelledby="live-capacity">
              <StepButton label="Fewer leaves per trip" disabled={job.capacity <= 1} onClick={() => set({ capacity: job.capacity - 1 })}>
                <Icons.minus />
              </StepButton>
              <output aria-live="polite" className="num w-8 text-center text-[13px] text-ink">
                {job.capacity}
              </output>
              <StepButton label="More leaves per trip" disabled={job.capacity >= MAX_CAPACITY} onClick={() => set({ capacity: job.capacity + 1 })}>
                <Icons.plus />
              </StepButton>
            </div>
          }
          hint="Each scoop tips into the bin; a full bin goes to the pile."
        />

        <Field
          label="Pile"
          value={<span className={`num text-[13px] ${!job.pile && !phonePile ? 'text-warn' : 'text-ink-2'}`}>{pileText}</span>}
          hint={map ? 'Click the live map to place it, or drop it where the rover is standing.' : "The pile can be placed once the phone's map is showing."}
        >
          <div className="flex flex-wrap gap-2">
            <Button variant={placing ? 'primary' : 'secondary'} aria-pressed={placing} disabled={!map} onClick={() => onPlacing(!placing)} className="flex-1">
              <Icons.pin />
              {placing ? 'Cancel' : 'Place on map'}
            </Button>
            <Button className="flex-1" disabled={!rover} onClick={() => set({ pile: rover && { x: rover.x, z: rover.z } })}>
              At the rover
            </Button>
          </div>
          {job.pile && (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => set({ pile: null })}>
              {phonePile ? "Use the phone's pile" : 'Clear'}
            </Button>
          )}
        </Field>
      </div>
    </Module>
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
