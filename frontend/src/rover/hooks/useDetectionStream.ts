import { useEffect, useState } from 'react'
import { LineSplitter, parseDetectionFrame, type DetectionFrame } from '../detections'

/** Boxes older than this are dropped: the detector stopped (or the phone went quiet). */
const STALE_MS = 2500
/** After the stream ends, try again this soon while the phone is still linked. */
const RETRY_MS = 2000

export type DetectionStream = {
  /** The newest boxes, or null when there are none to show. */
  frame: DetectionFrame | null
  /** The phone answered 404 for `/detections`: its app build is older than the boxes stream. */
  unsupported: boolean
}

/**
 * The phone's leaf detector boxes, live, while `origin` is set (the camera is linked): read from its
 * `/detections` stream with fetch, so changing phone or unlinking closes the connection. A phone whose
 * app predates the stream answers 404: that's reported (`unsupported`), and it's still retried quietly,
 * in case the app is updated while linked.
 */
export function useDetectionStream(origin: string | null): DetectionStream {
  const [frame, setFrame] = useState<DetectionFrame | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [receivedAt, setReceivedAt] = useState(0)
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!origin) return
    const controller = new AbortController()
    let retry: number | undefined
    const run = async () => {
      try {
        const response = await fetch(`${origin}/detections`, { signal: controller.signal, cache: 'no-store' })
        if (response.status === 404) setUnsupported(true)
        if (!response.ok || !response.body) throw new Error(`detections answered ${response.status}`)
        const reader = response.body.getReader()
        const lines = new LineSplitter()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const latest = lines.push(value).map(parseDetectionFrame).filter((f) => f != null).at(-1)
          if (latest) {
            setFrame(latest)
            setUnsupported(false)
            setReceivedAt(performance.now())
          }
        }
      } catch {
        // An older phone build has no /detections, or the phone went away: retry below.
      }
      if (!controller.signal.aborted) retry = window.setTimeout(() => void run(), RETRY_MS)
    }
    void run()
    return () => {
      controller.abort()
      window.clearTimeout(retry)
      setFrame(null)
      setUnsupported(false)
    }
  }, [origin])

  // Re-check staleness once a second, so boxes clear when updates stop.
  useEffect(() => {
    if (!origin) return
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(timer)
  }, [origin])

  const fresh = frame && !(now > 0 && now - receivedAt > STALE_MS) ? frame : null
  return { frame: fresh, unsupported }
}
