import type { AutopilotInput, Corridor, Heading, LiveMap, TrackedLeaf } from '@rover-brain'
import type { Direction } from './protocol'

/**
 * The web autopilot's two translations, kept pure so they're testable: the phone's live map into the
 * rover brain's autopilot input (so the browser can run the very same `stepAutopilot`), and the wheel
 * speeds it answers into one of the five buttons the ESP32 understands.
 */

/** What the browser has learnt while driving that the phone's map doesn't know: leaves scooped or given up on. */
export type PilotMemory = {
  collected: Map<number, number>
  failed: Set<number>
  checked: Set<number>
}

export const newMemory = (): PilotMemory => ({ collected: new Map(), failed: new Set(), checked: new Set() })

export function headingOf(rover: NonNullable<LiveMap['rover']>): Heading {
  const yaw = (rover.yawDeg * Math.PI) / 180
  const forward: [number, number, number] = [Math.sin(yaw), 0, -Math.cos(yaw)]
  return { origin: [rover.x, 0, rover.z], forward, right: [-forward[2], 0, forward[0]], yawDeg: rover.yawDeg }
}

/**
 * The autopilot's input from a map line `ageMs` old. Older phone builds don't say when a leaf was last
 * seen or how old the depth scan is: leaves then count as just seen, and corridors as fresh when present.
 */
export function inputFromMap(map: LiveMap, nowMs: number, ageMs: number, memory: PilotMemory): AutopilotInput {
  const leaves: TrackedLeaf[] = map.leaves.map((l) => {
    const collectedAt = memory.collected.get(l.id)
    return {
      id: l.id,
      world: [l.x, 0, l.z],
      label: 'leaf',
      score: 1,
      hits: 3,
      state: memory.failed.has(l.id) ? 'failed' : collectedAt != null ? 'collected' : l.state,
      source: 'lidar',
      firstSeenMs: nowMs,
      lastSeenMs: nowMs - ageMs - (l.seenAgoMs ?? 0),
      attempts: 0,
      collectedAtMs: collectedAt,
      missHits: 0,
      checked: memory.checked.has(l.id),
    }
  })
  const corridors: Corridor[] = map.corridors.map((c) => ({
    bearingDeg: c.bearingDeg,
    clearanceM: c.clearanceM,
    blockedBy: c.blocked ? 'obstacle' : null,
    observedM: c.clearanceM,
  }))
  const scanAgeMs = map.scanAgeMs === undefined ? (corridors.length ? ageMs : Infinity) : map.scanAgeMs === null ? Infinity : map.scanAgeMs + ageMs
  return {
    nowMs,
    heading: map.rover ? headingOf(map.rover) : null,
    leaves,
    corridors,
    scanAgeMs,
    pile: map.pile ? { center: [map.pile.x, 0, map.pile.z], radiusM: map.pile.radiusM } : null,
  }
}

/** Below this the wheels count as stopped (percent). */
const DEADBAND = 6

/**
 * Wheel speeds (percent, + forward) as a button: stop, a spin left or right when the step is mostly
 * turning, otherwise forward or back. The ESP32 drives each button at one fixed speed.
 */
export function directionFor(left: number, right: number): Direction | null {
  if (Math.max(Math.abs(left), Math.abs(right)) < DEADBAND) return null
  const forward = (left + right) / 2
  const turn = (left - right) / 2
  if (Math.abs(turn) > Math.abs(forward) * 0.75) return turn > 0 ? 'right' : 'left'
  return forward > 0 ? 'forward' : 'back'
}
