import { useCallback, useEffect, useRef, useState } from 'react'
import { useFrameCapture } from '../hooks/useFrameCapture'
import { CaptureControls } from './CaptureControls'

/**
 * The laptop webcam, until the rover's iPhone links up (PhoneCameraPanel takes over then): grabs frames
 * once a second into a folder as a numbered image set that pipeline/reconstruct.py accepts.
 */
export function CapturePanel() {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [on, setOn] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  const capture = useFrameCapture(async () => {
    const v = video.current
    if (!v || v.videoWidth === 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d')?.drawImage(v, 0, 0)
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  })
  const { stop: stopRecording } = capture

  const stopCamera = useCallback(() => {
    stopRecording()
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
    setOn(false)
  }, [stopRecording])

  useEffect(() => stopCamera, [stopCamera])

  const startCamera = async () => {
    setCameraError(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
        audio: false,
      })
      stream.current = s
      if (video.current) {
        video.current.srcObject = s
        await video.current.play()
      }
      setOn(true)
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : String(err))
    }
  }

  const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-40'

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Capture</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs ${
            capture.recording ? 'bg-red-500/20 text-red-300' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {capture.recording ? `recording · ${capture.count}` : on ? 'laptop webcam' : 'webcam stand-in'}
        </span>
      </div>

      <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
        <video ref={video} muted playsInline className="h-full w-full object-cover" />
        {!on && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-zinc-500">
            Open the leaf detector app on the iPhone (same Wi-Fi) to capture from it; or use the laptop webcam.
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {on ? (
          <button type="button" onClick={stopCamera} className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}>
            Stop webcam
          </button>
        ) : (
          <button type="button" onClick={startCamera} className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}>
            Use laptop webcam
          </button>
        )}
      </div>
      <CaptureControls capture={capture} ready={on} />
      {cameraError && <p className="mt-2 text-xs text-red-300">{cameraError}</p>}
    </section>
  )
}
