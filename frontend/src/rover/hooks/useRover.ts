import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RoverClient } from '../clients/RoverClient'
import { HttpRoverClient } from '../clients/HttpRoverClient'
import { SimulatedClient } from '../clients/SimulatedClient'
import { DEFAULT_ROVER_URL, directionOf, WHEEL_CODE, type Direction, type Jog, type Servo } from '../protocol'

export type Mode = 'simulated' | 'live'

const KEY_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: 'forward',
  w: 'forward',
  W: 'forward',
  ArrowDown: 'back',
  s: 'back',
  S: 'back',
  ArrowLeft: 'left',
  a: 'left',
  A: 'left',
  ArrowRight: 'right',
  d: 'right',
  D: 'right',
}
/** Hold to jog a servo: Q/E pan back/forward, R/F lift forward/back. */
const KEY_TO_JOG: Record<string, { servo: Servo; jog: Jog }> = {
  q: { servo: 'pan', jog: -1 },
  Q: { servo: 'pan', jog: -1 },
  e: { servo: 'pan', jog: 1 },
  E: { servo: 'pan', jog: 1 },
  r: { servo: 'lift', jog: 1 },
  R: { servo: 'lift', jog: 1 },
  f: { servo: 'lift', jog: -1 },
  F: { servo: 'lift', jog: -1 },
}
const STOP_KEYS = new Set([' ', 'Escape'])

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * The control page's hold-to-drive logic over a RoverClient: what's held is what the client's frame
 * says (its `motion`), so letting go, Stop, a lost connection or a new session all read back the same
 * way. The client itself repeats the frame while anything is held and stops on blur / hidden tab.
 */
export function useRover() {
  // Live rover by default: the control page is for the real rover; Simulated is the fallback to try things.
  const [mode, setMode] = useState<Mode>('live')
  const [url, setUrl] = useState(DEFAULT_ROVER_URL)
  const [client, setClient] = useState<RoverClient>(() => new HttpRoverClient(DEFAULT_ROVER_URL))
  const clientRef = useRef(client)

  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client])
  const getSnapshot = useCallback(() => client.getSnapshot(), [client])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const held = directionOf(snapshot.motion.wheel)
  const jogs = { pan: snapshot.motion.pan, lift: snapshot.motion.lift }

  /** Hard stop: zeroes wheels and both jogs in one frame. */
  const stop = useCallback(() => {
    clientRef.current.stop()
  }, [])

  const press = useCallback((direction: Direction) => {
    const c = clientRef.current
    if (c.getSnapshot().connection !== 'connected') return
    if (c.getSnapshot().motion.wheel === WHEEL_CODE[direction]) return
    c.set({ wheel: WHEEL_CODE[direction] })
  }, [])

  const release = useCallback((direction?: Direction) => {
    const c = clientRef.current
    const current = directionOf(c.getSnapshot().motion.wheel)
    if (current === null) return
    if (direction !== undefined && current !== direction) return
    c.set({ wheel: 0 })
  }, [])

  /** Hold-to-jog a servo; `0` lets go of it (it holds where it is). */
  const jog = useCallback((servo: Servo, value: Jog) => {
    const c = clientRef.current
    if (value !== 0 && c.getSnapshot().connection !== 'connected') return
    if (c.getSnapshot().motion[servo] === value) return
    c.set({ [servo]: value })
  }, [])

  const setPower = useCallback((power: number) => clientRef.current.set({ power }), [])
  const setSpeed = useCallback((speed: number) => clientRef.current.set({ speed }), [])

  /** Connects the current client; in live mode a different address replaces the client first. */
  const connect = useCallback(
    (nextUrl?: string) => {
      if (mode === 'live' && nextUrl !== undefined && nextUrl !== url) {
        clientRef.current.disconnect()
        const { power, speed } = clientRef.current.getSnapshot().motion
        const next = new HttpRoverClient(nextUrl)
        next.set({ power, speed })
        next.connect()
        setUrl(nextUrl)
        setClient(next)
        return
      }
      clientRef.current.connect()
    },
    [mode, url],
  )
  const disconnect = useCallback(() => clientRef.current.disconnect(), [])

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return
      clientRef.current.disconnect()
      const { power, speed } = clientRef.current.getSnapshot().motion
      const replacement: RoverClient = next === 'simulated' ? new SimulatedClient() : new HttpRoverClient(url)
      replacement.set({ power, speed })
      setMode(next)
      setClient(replacement)
    },
    [mode, url],
  )

  useEffect(() => {
    clientRef.current = client
    if (client.kind === 'simulated') client.connect()
    return () => client.disconnect()
  }, [client])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return
      const direction = KEY_TO_DIRECTION[e.key]
      const servo = KEY_TO_JOG[e.key]
      if (!direction && !servo && !STOP_KEYS.has(e.key)) return
      e.preventDefault()
      if (e.repeat) return
      if (direction) press(direction)
      else if (servo) jog(servo.servo, servo.jog)
      else stop()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const direction = KEY_TO_DIRECTION[e.key]
      const servo = KEY_TO_JOG[e.key]
      if (direction) release(direction)
      if (servo && clientRef.current.getSnapshot().motion[servo.servo] === servo.jog) jog(servo.servo, 0)
    }
    const onBlur = () => stop()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [press, release, jog, stop])

  return {
    mode,
    switchMode,
    url,
    snapshot,
    held,
    jogs,
    press,
    release,
    jog,
    stop,
    setPower,
    setSpeed,
    connect,
    disconnect,
  }
}

export type Rover = ReturnType<typeof useRover>
