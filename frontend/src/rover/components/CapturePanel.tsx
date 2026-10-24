import { useCallback, useEffect, useRef, useState } from 'react'

type Status = 'off' | 'preview' | 'recording'

const INTERVAL_MS = 1000

/**
 * Stand-in image source until the depth camera is specified: grabs frames from the
 * laptop webcam once a second into a folder (File System Access API) as a numbered
 * image set that pipeline/reconstruct.py accepts.
 */
export function CapturePanel() {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const dir = useRef<FileSystemDirectoryHandle | null>(null)
  const timer = useRef<number | null>(null)
  const frameIndex = useRef(0)
  const [status, setStatus] = useState<Status>('off')
  const [count, setCount] = useState(0)
  const [dirName, setDirName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const supportsFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const stopRecording = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    setStatus((s) => (s === 'recording' ? 'preview' : s))
  }, [])

  const stopCamera = useCallback(() => {
    stopRecording()
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
    setStatus('off')
  }, [stopRecording])

  useEffect(() => stopCamera, [stopCamera])

  const startCamera = async () => {
    setError(null)
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
      setStatus('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const chooseFolder = async () => {
    setError(null)
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      dir.current = handle
      setDirName(handle.name)
      frameIndex.current = 0
      setCount(0)
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') setError(err instanceof Error ? err.message : String(err))
    }
  }

  const grabFrame = async (): Promise<Blob | null> => {
    const v = video.current
    if (!v || v.videoWidth === 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d')?.drawImage(v, 0, 0)
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  }

  const saveFrame = async (blob: Blob, index: number) => {
    const name = `frame_${String(index).padStart(4, '0')}.jpg`
    if (dir.current) {
      const file = await dir.current.getFileHandle(name, { create: true })
      const writable = await file.createWritable()
      await writable.write(blob)
      await writable.close()
    } else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      a.click()
      URL.revokeObjectURL(a.href)
    }
  }

  const captureOne = async () => {
    const blob = await grabFrame()
    if (!blob) return
    frameIndex.current += 1
    setCount(frameIndex.current)
    try {
      await saveFrame(blob, frameIndex.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startRecording = () => {
    if (status !== 'preview') return
    setStatus('recording')
    void captureOne()
    timer.current = window.setInterval(() => void captureOne(), INTERVAL_MS)
  }

  const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-40'

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Capture</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs ${
            status === 'recording' ? 'bg-red-500/20 text-red-300' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {status === 'recording' ? `recording · ${count}` : status === 'preview' ? 'camera on' : 'webcam stand-in'}
        </span>
      </div>

      <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
        <video ref={video} muted playsInline className="h-full w-full object-cover" />
        {status === 'off' && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
            camera off — depth camera TBD, webcam used meanwhile
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {status === 'off' ? (
          <button type="button" onClick={startCamera} className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}>
            Start camera
          </button>
        ) : (
          <button type="button" onClick={stopCamera} className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}>
            Stop camera
          </button>
        )}
        {supportsFolder && (
          <button
            type="button"
            onClick={chooseFolder}
            disabled={status === 'recording'}
            className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}
          >
            {dirName ? `Folder: ${dirName}` : 'Choose folder…'}
          </button>
        )}
        {status === 'recording' ? (
          <button type="button" onClick={stopRecording} className={`${btn} bg-red-600 text-white hover:bg-red-500`}>
            Stop (1 fps)
          </button>
        ) : (
          <button
            type="button"
            onClick={startRecording}
            disabled={status !== 'preview'}
            className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}
          >
            Record 1 fps
          </button>
        )}
        <button
          type="button"
          onClick={() => void captureOne()}
          disabled={status === 'off'}
          className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}
        >
          Snap one
        </button>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Frames are saved as <span className="font-mono">frame_0001.jpg…</span>
        {supportsFolder ? ' into the chosen folder' : ' via downloads (choose a folder needs Chrome)'}. Walk slowly
        around the object with lots of overlap; 30–80 frames is a good first run.
      </p>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </section>
  )
}
