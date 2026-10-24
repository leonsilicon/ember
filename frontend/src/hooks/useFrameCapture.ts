import { useCallback, useEffect, useRef, useState } from 'react'

const INTERVAL_MS = 1000

/**
 * Saves camera frames as a numbered image set (`frame_0001.jpg…`) that pipeline/reconstruct.py accepts:
 * into a chosen folder (File System Access API, Chrome) or as downloads. `grab` returns the frame to
 * save, from whichever camera the panel shows (the laptop webcam or the rover's iPhone).
 */
export function useFrameCapture(grab: () => Promise<Blob | null>) {
  const dir = useRef<FileSystemDirectoryHandle | null>(null)
  const timer = useRef<number | null>(null)
  const frameIndex = useRef(0)
  /** A grab still running; the next tick waits for it rather than piling up. */
  const busy = useRef(false)
  const grabRef = useRef(grab)
  const [recording, setRecording] = useState(false)
  const [count, setCount] = useState(0)
  const [dirName, setDirName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const supportsFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  useEffect(() => {
    grabRef.current = grab
  })

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    setRecording(false)
  }, [])

  useEffect(() => stop, [stop])

  const chooseFolder = useCallback(async () => {
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
  }, [])

  const save = async (blob: Blob, index: number) => {
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

  const snap = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const blob = await grabRef.current()
      if (!blob) return
      frameIndex.current += 1
      setCount(frameIndex.current)
      await save(blob, frameIndex.current)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      busy.current = false
    }
  }, [])

  const start = useCallback(() => {
    if (timer.current !== null) return
    setRecording(true)
    void snap()
    timer.current = window.setInterval(() => void snap(), INTERVAL_MS)
  }, [snap])

  return { recording, count, dirName, error, supportsFolder, chooseFolder, snap, start, stop }
}

export type FrameCapture = ReturnType<typeof useFrameCapture>
