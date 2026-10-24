import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiscoveredPhone } from '../../phone-discovery'
import { useFrameCapture } from '../hooks/useFrameCapture'
import { CaptureControls } from './CaptureControls'
import { useDetectionStream } from '../hooks/useDetectionStream'
import { DetectionBoxes } from './DetectionBoxes'
import { MjpegView } from './MjpegView'
import { PHONE_CAMERA_PORT, phoneCameraOrigin } from '../phoneCamera'

const STORAGE_KEY = 'rover.phoneCameraAddress'
const STATUS_TIMEOUT_MS = 3000
const POLL_MS = 2000
/** Missed status checks in a row before the phone counts as gone (an ended stream leaves its last frame up). */
const LOST_AFTER = 2
/** After a failed link-up with a found phone, wait this long before trying it again. */
const AUTO_RETRY_MS = 5000
/** Captured frames are stills this size (longer side), encoded fresh on the phone, not stream frames. */
const CAPTURE_SIZE = 1920
const CAPTURE_TIMEOUT_MS = 4000

type PhoneStatus = { device: string; viewers: number; frames: number; width: number; height: number }

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'streaming'; device: string }
  | { kind: 'error'; message: string }

function readSaved(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

async function fetchStatus(origin: string): Promise<PhoneStatus> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
  try {
    const response = await fetch(`${origin}/status`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`the phone answered ${response.status}`)
    return (await response.json()) as PhoneStatus
  } finally {
    window.clearTimeout(timer)
  }
}

/** "http://192.168.1.23:8787" → "192.168.1.23" (the port only when it isn't the app's own). */
const displayAddress = (origin: string) => origin.replace(/^https?:\/\//, '').replace(new RegExp(`:${PHONE_CAMERA_PORT}$`), '')

/**
 * Capture from the camera of the iPhone riding on the rover, streamed over the Wi-Fi by the leaf detector
 * app while its camera screen is open. The live view is the MJPEG stream; captured frames are
 * full-resolution stills the phone encodes on request (`/frame.jpg?size=1920`). `discovered` is a phone the dev server
 * found on the Wi-Fi (usePhoneDiscovery): the panel links up with it by itself, unless the user stopped.
 */
export function PhoneCameraPanel({ discovered = null }: { discovered?: DiscoveredPhone | null }) {
  const [address, setAddress] = useState(readSaved)
  // A remembered phone is reconnected to as the panel opens.
  const [initialOrigin] = useState(() => phoneCameraOrigin(address))
  const [state, setState] = useState<State>(() => (initialOrigin ? { kind: 'checking' } : { kind: 'idle' }))
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [viewers, setViewers] = useState(0)
  /** Frames shown since the stream opened, and when the frame rate was last worked out from it. */
  const shownFrames = useRef(0)
  const lastFrames = useRef<{ frames: number; at: number } | null>(null)
  const missed = useRef(0)
  /** The newest stream frame: what's saved if a full-resolution still can't be had. */
  const latestFrame = useRef<Blob | null>(null)
  /** The user pressed Stop: don't link up again by itself until they press Connect. */
  const [stopped, setStopped] = useState(false)
  const lastAuto = useRef<{ origin: string; at: number } | null>(null)
  const origin = phoneCameraOrigin(address)
  const insecurePage = typeof window !== 'undefined' && window.location.protocol === 'https:'

  const disconnect = useCallback(() => {
    setStopped(true)
    setStreamUrl(null)
    setFps(null)
    lastFrames.current = null
    setState({ kind: 'idle' })
  }, [])

  /** Checks the phone answers, then opens its stream. */
  const check = useCallback(async (target: string) => {
    try {
      const status = await fetchStatus(target)
      shownFrames.current = 0
      lastFrames.current = null
      setState({ kind: 'streaming', device: status.device })
      // A fresh query each time, so reconnecting never reuses a stalled stream.
      setStreamUrl(`${target}/camera.mjpg?v=${Date.now()}`)
    } catch {
      setState({
        kind: 'error',
        message: `Can't reach the phone at ${target.replace('http://', '')}. Check it's on the same Wi-Fi with the rover app's camera screen open.`,
      })
    }
  }, [])

  const connect = useCallback(() => {
    if (!origin) {
      setState({ kind: 'error', message: 'Enter the address the rover app shows, e.g. 192.168.1.23' })
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, address.trim())
    } catch {
      // Private mode: the address just isn't remembered.
    }
    setStopped(false)
    setStreamUrl(null)
    setState({ kind: 'checking' })
    void check(origin)
  }, [address, origin, check])

  // Link up with a phone found on the Wi-Fi: as soon as it appears, and again (after a pause) if it
  // drops out and comes back.
  useEffect(() => {
    if (!discovered || stopped || state.kind === 'streaming' || state.kind === 'checking') return
    const previous = lastAuto.current
    const wait = previous?.origin === discovered.origin ? Math.max(0, AUTO_RETRY_MS - (Date.now() - previous.at)) : 0
    const timer = window.setTimeout(() => {
      lastAuto.current = { origin: discovered.origin, at: Date.now() }
      const shown = displayAddress(discovered.origin)
      setAddress(shown)
      try {
        localStorage.setItem(STORAGE_KEY, shown)
      } catch {
        // Private mode: the address just isn't remembered.
      }
      setStreamUrl(null)
      setState({ kind: 'checking' })
      void check(discovered.origin)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [discovered, stopped, state.kind, check])

  useEffect(() => {
    if (!initialOrigin) return
    const timer = window.setTimeout(() => void check(initialOrigin), 0)
    return () => window.clearTimeout(timer)
  }, [initialOrigin, check])

  // While streaming: the frame rate as shown here, and how many are watching. The status check is also
  // what notices a phone that has gone quiet without closing the stream (e.g. it left the Wi-Fi).
  useEffect(() => {
    if (state.kind !== 'streaming' || !origin) return
    missed.current = 0
    const timer = window.setInterval(async () => {
      try {
        const status = await fetchStatus(origin)
        missed.current = 0
        const now = performance.now()
        const prev = lastFrames.current
        const frames = shownFrames.current
        if (prev) setFps(Math.max(0, Math.round(((frames - prev.frames) * 1000) / (now - prev.at))))
        lastFrames.current = { frames, at: now }
        setViewers(status.viewers)
      } catch {
        missed.current += 1
        if (missed.current >= LOST_AFTER) {
          setStreamUrl(null)
          setFps(null)
          lastFrames.current = null
          setState({ kind: 'error', message: 'Lost the phone. Is it still on the Wi-Fi with the rover app open on its camera screen?' })
        }
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [state.kind, origin])

  const busy = state.kind === 'checking'
  const streaming = state.kind === 'streaming'

  // The leaf detector's boxes, while linked: drawn over the picture, never into captured frames.
  const [showBoxes, setShowBoxes] = useState(true)
  const detections = useDetectionStream(streaming && showBoxes ? origin : null)
  const frameAspect = detections && detections.width > 0 ? detections.width / detections.height : 3 / 4

  const capture = useFrameCapture(async () => {
    if (!origin) return null
    try {
      const response = await fetch(`${origin}/frame.jpg?size=${CAPTURE_SIZE}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      })
      if (response.ok) return await response.blob()
    } catch {
      // Slow or refused: fall back to the stream's newest frame below.
    }
    return latestFrame.current
  })
  const { stop: stopRecording } = capture
  // Recording stops with the stream: the phone gone, or the user stopping it.
  useEffect(() => {
    if (!streaming) stopRecording()
  }, [streaming, stopRecording])

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-zinc-300 uppercase">
          Capture
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium tracking-normal normal-case ${
              capture.recording ? 'bg-red-500/20 text-red-300' : 'bg-sky-500/15 text-sky-300'
            }`}
          >
            {capture.recording ? `recording · ${capture.count}` : 'iPhone camera'}
          </span>
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              streaming ? (fps === 0 ? 'bg-amber-400' : 'bg-emerald-400') : state.kind === 'error' ? 'bg-red-400' : busy ? 'bg-amber-400' : 'bg-zinc-600'
            }`}
          />
          {streaming
            ? fps === 0
              ? `${state.device} · picture frozen: camera screen closed?`
              : `${state.device}${fps != null ? ` · ${fps} fps` : ''}${viewers > 1 ? ` · ${viewers} watching` : ''}`
            : busy
              ? 'Connecting…'
              : state.kind === 'error'
                ? 'Not connected'
                : 'Off'}
        </span>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          connect()
        }}
      >
        <label className="sr-only" htmlFor="phone-camera-address">
          Phone address
        </label>
        <input
          id="phone-camera-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="192.168.1.23"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/30"
        />
        {streaming ? (
          <button
            type="button"
            onClick={disconnect}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-60"
          >
            {state.kind === 'error' ? 'Retry' : 'Connect'}
          </button>
        )}
      </form>

      <div className="relative mt-3 flex aspect-[3/4] max-h-[420px] w-full items-center justify-center overflow-hidden rounded-lg bg-zinc-950">
        {streamUrl ? (
          // Sized to the frame, so the boxes' fractions land on the picture, not the letterbox.
          <div className="relative h-full max-w-full" style={{ aspectRatio: frameAspect }}>
            <MjpegView
              url={streamUrl}
              alt="Live view from the rover's iPhone"
              className="h-full w-full object-fill"
              onFrame={(jpeg) => {
                shownFrames.current += 1
                latestFrame.current = jpeg
              }}
              onEnd={() => {
                setStreamUrl(null)
                setFps(null)
                setState({ kind: 'error', message: 'The phone stopped streaming. Is the rover app still open on its camera screen?' })
              }}
            />
            {showBoxes && detections && <DetectionBoxes boxes={detections.boxes} />}
            <button
              type="button"
              aria-pressed={showBoxes}
              onClick={() => setShowBoxes((v) => !v)}
              className="absolute right-2 bottom-2 rounded-md bg-zinc-950/80 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-400"
            >
              {showBoxes ? `Boxes on${detections ? ` · ${detections.boxes.length}` : ''}` : 'Boxes off'}
            </button>
          </div>
        ) : (
          <p className="max-w-[30ch] px-4 text-center text-xs leading-relaxed text-zinc-500">
            {state.kind === 'error'
              ? state.message
              : busy
                ? 'Looking for the phone…'
                : "Open the rover app on the iPhone, on the same Wi-Fi: it links up here by itself. (Or enter the address from the cast icon at the top of its camera screen.)"}
          </p>
        )}
      </div>

      <CaptureControls capture={capture} ready={streaming} />

      {insecurePage && (
        <p className="mt-2 text-xs text-amber-300">
          This page is on https, which browsers won't let load the phone's http stream. Open the web app over http (e.g. the
          dev server) for live view.
        </p>
      )}
    </section>
  )
}
