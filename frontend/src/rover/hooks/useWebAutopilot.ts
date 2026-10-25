import { DEFAULT_AUTOPILOT, initialAutopilotState, stepAutopilot, type AutopilotState } from '@rover-brain'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Direction } from '../protocol'
import { directionFor, inputFromMap, newMemory } from '../webPilot'
import type { LiveMapStream } from './useLiveMap'
import type { Rover } from './useRover'

/** No map line for this long while driving: stop and switch off (the phone went quiet). */
const MAP_TIMEOUT_MS = 700

export type WebAutopilot = {
  on: boolean
  /** What it's doing, or why it can't start / stopped. */
  message: string
  mode: AutopilotState['mode'] | null
  targetId: number | null
  /** The button it's holding right now. */
  pressing: Direction | null
  load: number
  /** Why Start is unavailable, or null when it can start. */
  blocker: string | null
  start: () => void
  stop: (reason?: string) => void
}

/**
 * The rover brain's own autopilot, run in the browser on the phone's live map, driving through the
 * same buttons a person presses: each map update (5 a second) it steps `stepAutopilot` and holds the
 * D-pad direction its wheel speeds come to (so the buttons animate and the ESP32 gets exactly what a
 * person would send). The scoop's arm sequence runs as it starts scooping. It switches itself off,
 * stopping the rover, when someone drives or stops by hand, the map goes quiet, or the rover drops.
 */
export function useWebAutopilot(rover: Rover, live: LiveMapStream, enabled: boolean): WebAutopilot {
  const [on, setOn] = useState(false)
  const onRef = useRef(false)
  const [status, setStatus] = useState<{ message: string; mode: AutopilotState['mode'] | null; targetId: number | null; load: number }>({
    message: '',
    mode: null,
    targetId: null,
    load: 0,
  })
  const [pressing, setPressing] = useState<Direction | null>(null)
  const state = useRef<AutopilotState | null>(null)
  const memory = useRef(newMemory())
  const pressingRef = useRef<Direction | null>(null)
  const roverRef = useRef(rover)
  useEffect(() => {
    roverRef.current = rover
  })

  const connected = rover.snapshot.connection === 'connected'
  const { map, receivedAt } = live
  const blocker = !enabled
    ? 'Switch to Live rover to use the autopilot.'
    : !connected
      ? 'Connect to the rover first.'
      : !map
        ? "Link the rover's iPhone: the autopilot steers by its live map."
        : !map.pile
          ? 'Set the pile on the phone first: the autopilot works the circle round it.'
          : null

  const hold = useCallback((direction: Direction | null) => {
    if (pressingRef.current === direction) return
    pressingRef.current = direction
    setPressing(direction)
    if (direction) roverRef.current.press(direction)
    else roverRef.current.stop()
  }, [])

  const stop = useCallback((reason?: string) => {
    if (onRef.current) {
      pressingRef.current = null
      setPressing(null)
      roverRef.current.stop()
    }
    onRef.current = false
    state.current = null
    setOn(false)
    setStatus((s) => ({ ...s, message: reason ?? 'Stopped', mode: null, targetId: null }))
  }, [])

  const start = useCallback(() => {
    if (blocker) return
    state.current = initialAutopilotState(performance.now(), 0)
    memory.current = newMemory()
    setStatus({ message: 'Starting…', mode: 'searching', targetId: null, load: 0 })
    onRef.current = true
    setOn(true)
  }, [blocker])

  // One step per map update.
  useEffect(() => {
    if (!on || !map || !state.current) return
    const now = performance.now()
    const cfg = { ...DEFAULT_AUTOPILOT, workRadiusM: map.workRadiusM, capacity: map.capacity }
    const step = stepAutopilot(state.current, inputFromMap(map, now, Math.max(0, now - receivedAt), memory.current), cfg)
    const entering = step.state.mode !== state.current.mode ? step.state.mode : null
    state.current = step.state
    for (const id of step.collectedIds ?? []) memory.current.collected.set(id, now)
    if (step.missingId != null) memory.current.collected.set(step.missingId, now)
    if (step.failedId != null) memory.current.failed.add(step.failedId)
    if (step.checkedId != null) memory.current.checked.add(step.checkedId)
    // The arm sequence is the scoop: run it once as each scoop starts.
    if (entering === 'scooping') roverRef.current.runArm()
    hold(directionFor(step.left, step.right))
    // The step is the source of truth for the panel, mirrored into state for rendering.
    setStatus({ message: step.message, mode: step.state.mode, targetId: step.state.targetId ?? null, load: step.state.load })
  }, [on, map, receivedAt, hold])

  // Safety: the map going quiet, the rover dropping, or leaving live mode stops it.
  useEffect(() => {
    if (!on) return
    const timer = window.setInterval(() => {
      if (performance.now() - live.receivedAt > MAP_TIMEOUT_MS) stop('Stopped: the live map stopped updating')
    }, 150)
    return () => window.clearInterval(timer)
  }, [on, live.receivedAt, stop])
  useEffect(() => {
    if (on && (!connected || !enabled)) {
      const timer = window.setTimeout(() => stop(!connected ? 'Stopped: the rover disconnected' : 'Stopped'), 0)
      return () => window.clearTimeout(timer)
    }
  }, [on, connected, enabled, stop])

  // Driving or stopping by hand takes over: drive keys, Space or Esc switch the autopilot off.
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (['w', 'a', 's', 'd', 'W', 'A', 'S', 'D', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Escape'].includes(e.key)) {
        stop('Stopped: driving by hand')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [on, stop])

  useEffect(() => () => roverRef.current.stop(), [])

  return { on, ...status, pressing, blocker, start, stop }
}
