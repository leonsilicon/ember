import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RoverClient } from '../clients/RoverClient'
import { SimulatedClient } from '../clients/SimulatedClient'
import { WebSocketClient } from '../clients/WebSocketClient'
import { DEFAULT_WS_URL, DRIVE_REPEAT_MS, type Direction } from '../protocol'

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
const STOP_KEYS = new Set([' ', 'Escape'])

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function useRover() {
  const [mode, setMode] = useState<Mode>('simulated')
  const [url, setUrl] = useState(DEFAULT_WS_URL)
  const [client, setClient] = useState<RoverClient>(() => new SimulatedClient())
  const clientRef = useRef(client)

  const heldRef = useRef<Direction | null>(null)
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const [held, setHeld] = useState<Direction | null>(null)

  const clearRepeat = useCallback(() => {
    if (repeatTimer.current !== null) {
      clearInterval(repeatTimer.current)
      repeatTimer.current = null
    }
    heldRef.current = null
    setHeld(null)
  }, [])

  // Any drop out of `connected` kills the held direction so a later reconnect
  // can never resume motion without a fresh press.
  const subscribe = useCallback(
    (listener: () => void) =>
      client.subscribe(() => {
        if (client.getSnapshot().connection !== 'connected') clearRepeat()
        listener()
      }),
    [client, clearRepeat],
  )
  const getSnapshot = useCallback(() => client.getSnapshot(), [client])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  /** Hard stop: clears any held direction and always sends `stop`. */
  const stop = useCallback(() => {
    clearRepeat()
    if (clientRef.current.getSnapshot().connection === 'connected') {
      clientRef.current.send('stop')
    }
  }, [clearRepeat])

  const press = useCallback(
    (direction: Direction) => {
      if (heldRef.current === direction) return
      if (clientRef.current.getSnapshot().connection !== 'connected') return
      clearRepeat()
      heldRef.current = direction
      setHeld(direction)
      clientRef.current.send(direction)
      repeatTimer.current = setInterval(() => {
        clientRef.current.send(direction)
      }, DRIVE_REPEAT_MS)
    },
    [clearRepeat],
  )

  const release = useCallback(
    (direction?: Direction) => {
      if (heldRef.current === null) return
      if (direction !== undefined && heldRef.current !== direction) return
      stop()
    },
    [stop],
  )

  const runArm = useCallback(() => {
    clientRef.current.send('arm_run')
  }, [])

  /** Connects the current client; in live mode a different URL replaces the client first. */
  const connect = useCallback(
    (nextUrl?: string) => {
      if (mode === 'live' && nextUrl !== undefined && nextUrl !== url) {
        clearRepeat()
        clientRef.current.disconnect()
        const next = new WebSocketClient(nextUrl)
        next.connect()
        setUrl(nextUrl)
        setClient(next)
        return
      }
      clientRef.current.connect()
    },
    [mode, url, clearRepeat],
  )
  const disconnect = useCallback(() => {
    clearRepeat()
    clientRef.current.disconnect()
  }, [clearRepeat])

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return
      clearRepeat()
      clientRef.current.disconnect()
      setMode(next)
      setClient(next === 'simulated' ? new SimulatedClient() : new WebSocketClient(url))
    },
    [mode, url, clearRepeat],
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
      if (!direction && !STOP_KEYS.has(e.key)) return
      e.preventDefault()
      if (e.repeat) return
      if (direction) press(direction)
      else stop()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const direction = KEY_TO_DIRECTION[e.key]
      if (direction) release(direction)
    }
    const onBlur = () => release()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release()
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
  }, [press, release, stop])

  useEffect(() => clearRepeat, [clearRepeat])

  return {
    mode,
    switchMode,
    url,
    snapshot,
    held,
    press,
    release,
    stop,
    runArm,
    connect,
    disconnect,
  }
}

export type Rover = ReturnType<typeof useRover>
