import { useEffect, useRef, useState } from 'react'
import type { SimController } from '../../sim/controller'
import type { Overlays } from '../../sim/overlays'
import { SimScene3D } from '../../sim3d/scene'
import { IconButton, Icons } from '../../ui/kit'
import { isShortcutEvent, type Shortcut } from '../../ui/Shell'

type Props = { controller: SimController; overlays: Overlays }

export const VIEW_SHORTCUTS: Shortcut[] = [
  { keys: ['F'], label: 'Follow the rover' },
  { keys: ['T'], label: 'Top-down camera' },
  { keys: ['0'], label: 'Reset the camera' },
]

/** The 3D view: a three.js scene over the controller's sim, created on mount and fully disposed on unmount. */
export function ThreeView({ controller, overlays }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SimScene3D | null>(null)
  const [follow, setFollow] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const scene = new SimScene3D(mount, controller)
    sceneRef.current = scene
    return () => {
      sceneRef.current = null
      scene.dispose()
    }
  }, [controller])

  useEffect(() => {
    sceneRef.current?.setOverlays(overlays)
  }, [overlays, controller])

  useEffect(() => {
    sceneRef.current?.setFollow(follow)
  }, [follow, controller])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcutEvent(e)) return
      const key = e.key.toLowerCase()
      if (key === 'f') setFollow((f) => !f)
      else if (key === 't') sceneRef.current?.topDown()
      else if (key === '0') sceneRef.current?.resetView()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="absolute inset-0">
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute top-3 right-3 flex flex-col gap-0.5 rounded-[10px] border border-line bg-panel/95 p-1 shadow-float backdrop-blur-sm" role="toolbar" aria-label="Camera" aria-orientation="vertical">
        <IconButton label="Follow the rover (F)" pressed={follow} onClick={() => setFollow((f) => !f)}>
          <Icons.follow />
        </IconButton>
        <IconButton label="Top-down camera (T)" onClick={() => sceneRef.current?.topDown()}>
          <Icons.topDown />
        </IconButton>
        <IconButton label="Reset the camera (0)" onClick={() => sceneRef.current?.resetView()}>
          <Icons.resetView />
        </IconButton>
      </div>
    </div>
  )
}
