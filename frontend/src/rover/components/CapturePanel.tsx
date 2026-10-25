import { useCallback, useEffect, useRef, useState } from 'react'
import { useFrameCapture } from '../hooks/useFrameCapture'
import { Button, Icons, Led } from '../ui/kit'
import { Module } from '../ui/layout'
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

  return (
    <Module
      id="camera"
      title="Camera"
      meta={
        <span className="inline-flex items-center gap-1.5">
          <Led tone={capture.recording ? 'danger' : on ? 'ok' : 'off'} blink={capture.recording} />
          {capture.recording ? `rec · ${capture.count}` : on ? 'laptop webcam' : 'off'}
        </span>
      }
      flush
    >
      <div className="relative aspect-video overflow-hidden bg-stage">
        <video ref={video} muted playsInline className="h-full w-full object-cover" />
        {!on && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs leading-relaxed text-[#a8a29a]">
            Open the leaf detector app on the iPhone (same Wi-Fi) to capture from it, or use the laptop webcam.
          </div>
        )}
      </div>
      <div className="border-t border-line px-3.5 pt-3 pb-3.5">
        {on ? (
          <Button size="sm" onClick={stopCamera}>
            Stop webcam
          </Button>
        ) : (
          <Button size="sm" onClick={startCamera}>
            <Icons.camera />
            Use laptop webcam
          </Button>
        )}
        <CaptureControls capture={capture} ready={on} />
        {cameraError && <p className="mt-2 text-xs text-danger">{cameraError}</p>}
      </div>
    </Module>
  )
}
