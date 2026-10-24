import { useEffect, useRef, useState } from 'react'
import type { SimController } from '../../sim/controller'
import type { Overlays } from '../../sim/overlays'
import { SimScene3D } from '../../sim3d/scene'

type Props = { controller: SimController; overlays: Overlays }

const BUTTON = 'rounded-md bg-zinc-800/90 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700'

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

  return (
    <div className="absolute inset-0">
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute right-3 bottom-3 flex gap-2">
        <button
          type="button"
          aria-pressed={follow}
          onClick={() => setFollow((f) => !f)}
          className={`rounded-md px-2.5 py-1 text-xs ${follow ? 'bg-sky-500 text-zinc-950 hover:bg-sky-400' : 'bg-zinc-800/90 text-zinc-200 hover:bg-zinc-700'}`}
        >
          Follow rover
        </button>
        <button type="button" onClick={() => sceneRef.current?.topDown()} className={BUTTON}>
          Top-down
        </button>
        <button type="button" onClick={() => sceneRef.current?.resetView()} className={BUTTON}>
          Reset view
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 hidden rounded bg-zinc-950/60 px-2 py-0.5 text-[11px] text-zinc-300 xl:block">
        drag to orbit · scroll to zoom · drag a leaf to move it
      </p>
    </div>
  )
}
