import { useEffect, useRef } from 'react'
import { MjpegParser } from '../mjpeg'

type Props = {
  url: string
  alt: string
  className?: string
  /** Each frame shown. */
  onFrame?: () => void
  /** The stream ended or failed (not called when it's closed by a new `url` or unmounting). */
  onEnd?: () => void
}

/**
 * Plays an MJPEG stream by reading it with fetch and showing each JPEG, rather than handing the URL to
 * an <img>: Chrome doesn't reliably close an <img>'s MJPEG connection when its src changes or it's
 * removed, and every connection left open costs the phone encoding and Wi-Fi. Aborting a fetch always
 * closes it, and a stream that ends is noticed straight away.
 */
export function MjpegView({ url, alt, className, onFrame, onEnd }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const callbacks = useRef({ onFrame, onEnd })
  useEffect(() => {
    callbacks.current = { onFrame, onEnd }
  })

  useEffect(() => {
    const controller = new AbortController()
    let shown: string | null = null
    const run = async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`)
        const reader = response.body.getReader()
        const parser = new MjpegParser()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          // Only the newest of a burst is worth decoding.
          const frame = parser.push(value).at(-1)
          if (!frame || !imgRef.current) continue
          const next = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }))
          imgRef.current.src = next
          if (shown) URL.revokeObjectURL(shown)
          shown = next
          callbacks.current.onFrame?.()
        }
        if (!controller.signal.aborted) callbacks.current.onEnd?.()
      } catch {
        if (!controller.signal.aborted) callbacks.current.onEnd?.()
      }
    }
    void run()
    return () => {
      controller.abort()
      if (shown) URL.revokeObjectURL(shown)
    }
  }, [url])

  return <img ref={imgRef} alt={alt} className={className} />
}
