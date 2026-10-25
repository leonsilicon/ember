import { parseLiveMap, type LiveMap } from '@rover-brain'
import { useEffect, useState } from 'react'
import { LineSplitter } from '../detections'

/** After the stream ends, try again this soon while the phone is still linked. */
const RETRY_MS = 2000
/** Trail points closer than this to the last one aren't kept; at most this many are. */
const TRAIL_STEP_M = 0.03
const TRAIL_MAX = 800

export type LiveMapStream = {
  map: LiveMap | null
  /** performance.now() of the newest map line, 0 before the first. */
  receivedAt: number
  /** The rover's path so far this session, x/z in metres. */
  trail: readonly [number, number][]
  /** The phone answers but has sent no map: its app build predates the live map. */
  silent: boolean
}

/**
 * The rover brain's map, live, from the linked phone's `/detections` stream (the map lines beside the
 * box lines, rover-brain/live-map.ts). Its own connection, so it runs whether or not the camera picture
 * is on screen; changing phone or unlinking closes it.
 */
export function useLiveMap(origin: string | null): LiveMapStream {
  const [map, setMap] = useState<LiveMap | null>(null)
  const [receivedAt, setReceivedAt] = useState(0)
  const [silent, setSilent] = useState(false)
  const [trail, setTrail] = useState<[number, number][]>([])

  useEffect(() => {
    if (!origin) return
    const controller = new AbortController()
    let retry: number | undefined
    let silentTimer: number | undefined
    let gotMap = false
    const run = async () => {
      try {
        const response = await fetch(`${origin}/detections`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !response.body) throw new Error(`detections answered ${response.status}`)
        // Box lines but no map lines for a while: the phone's app is older than the live map.
        silentTimer = window.setTimeout(() => !gotMap && setSilent(true), 4000)
        const reader = response.body.getReader()
        const lines = new LineSplitter()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const latest = lines.push(value).map(parseLiveMap).filter((m) => m != null).at(-1)
          if (!latest) continue
          gotMap = true
          setSilent(false)
          setMap(latest)
          setReceivedAt(performance.now())
          const r = latest.rover
          if (r) {
            setTrail((t) => {
              const last = t.at(-1)
              return last && Math.hypot(r.x - last[0], r.z - last[1]) <= TRAIL_STEP_M ? t : [...t.slice(-(TRAIL_MAX - 1)), [r.x, r.z]]
            })
          }
        }
      } catch {
        // The phone went away (or this build has no /detections): retry below.
      }
      window.clearTimeout(silentTimer)
      if (!controller.signal.aborted) retry = window.setTimeout(() => void run(), RETRY_MS)
    }
    void run()
    return () => {
      controller.abort()
      window.clearTimeout(retry)
      window.clearTimeout(silentTimer)
      setTrail([])
      setMap(null)
      setReceivedAt(0)
      setSilent(false)
    }
  }, [origin])

  return { map, receivedAt, trail, silent }
}
