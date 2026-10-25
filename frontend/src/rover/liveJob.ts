import { DEFAULT_AUTOPILOT, DEFAULT_PILE_RADIUS_M, type LiveMap } from '@rover-brain'
import { useEffect, useState } from 'react'
import { ftToM, WORK_RADIUS_FT } from './sim/worlds'

/**
 * The live rover's job, set on the control page like the simulator's: how far round the pile to clear,
 * how many leaves to bring back a trip, and (optionally) where the pile is, in place of the one set on
 * the phone. The web autopilot works to it and the live top view draws it.
 */
export type LiveJob = {
  radiusFt: number
  capacity: number
  /** AR-world floor position; null uses the pile set on the phone. */
  pile: { x: number; z: number } | null
}

export const MAX_CAPACITY = 8
const KEY = 'ember.liveJob'

export const DEFAULT_JOB: LiveJob = { radiusFt: WORK_RADIUS_FT.default, capacity: DEFAULT_AUTOPILOT.capacity, pile: null }

function load(): LiveJob {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LiveJob> | null
    if (!saved) return DEFAULT_JOB
    const radiusFt = Math.min(WORK_RADIUS_FT.max, Math.max(WORK_RADIUS_FT.min, Math.round(Number(saved.radiusFt) || DEFAULT_JOB.radiusFt)))
    const capacity = Math.min(MAX_CAPACITY, Math.max(1, Math.round(Number(saved.capacity) || DEFAULT_JOB.capacity)))
    const pile = saved.pile && Number.isFinite(saved.pile.x) && Number.isFinite(saved.pile.z) ? saved.pile : null
    return { radiusFt, capacity, pile }
  } catch {
    return DEFAULT_JOB
  }
}

/** The job, remembered in this browser (an AR world lasts one phone session, so a stale pile is easy to clear). */
export function useLiveJob() {
  const [job, setJob] = useState<LiveJob>(load)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(job))
    } catch {
      // Private mode: the job lasts for this visit.
    }
  }, [job])
  return [job, setJob] as const
}

/** The phone's map with the job applied: the radius, the bin size and, when set here, the pile. */
export function applyJob(map: LiveMap | null, job: LiveJob): LiveMap | null {
  if (!map) return map
  return {
    ...map,
    workRadiusM: ftToM(job.radiusFt),
    capacity: job.capacity,
    pile: job.pile ? { x: job.pile.x, z: job.pile.z, radiusM: map.pile?.radiusM ?? DEFAULT_PILE_RADIUS_M } : map.pile,
  }
}
