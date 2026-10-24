import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

export const SAMPLE_SPLAT_URL = '/splats/leaf-floor.splat'

// Scene convention: ground is the y=0 plane and up is -y (cameraUp below). The default view looks down
// at ~35° onto the middle of the ~4.6 m leaf-floor sample.
const CAMERA_POSITION: [number, number, number] = [0, -1.45, -2.25]
const CAMERA_LOOK_AT: [number, number, number] = [0, 0, 0.2]

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: number; label: string }
  | { kind: 'ready'; label: string; splats: number }
  | { kind: 'error'; message: string }

type Props = {
  /** URL or object URL of a .splat/.ply/.ksplat scene. */
  source: string | null
  /** Human-readable name shown in the overlay. */
  label?: string
}

export function SplatViewer({ source, label }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<GaussianSplats3D.Viewer | null>(null)
  const [state, setState] = useState<LoadState>({ kind: 'idle' })

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const viewer = new GaussianSplats3D.Viewer({
      rootElement: mount,
      cameraUp: [0, -1, 0],
      initialCameraPosition: CAMERA_POSITION,
      initialCameraLookAt: CAMERA_LOOK_AT,
      sharedMemoryForWorkers: false,
      gpuAcceleratedSort: false,
      sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
      sphericalHarmonicsDegree: 0,
    })
    viewerRef.current = viewer
    // The library binds WASD panning and debug hotkeys on window; those keys belong to the rover.
    for (const controls of [viewer.perspectiveControls, viewer.orthographicControls]) controls?.stopListenToKeyEvents()
    if (viewer.keyDownListener) window.removeEventListener('keydown', viewer.keyDownListener)
    const renderer = viewer.renderer as THREE.WebGLRenderer

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect()
      if (width === 0 || height === 0) return
      renderer.setSize(width, height)
      const camera = viewer.camera as THREE.PerspectiveCamera
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    return () => {
      observer.disconnect()
      viewerRef.current = null
      viewer.dispose().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    let cancelled = false
    const name = label ?? source ?? ''

    const load = async () => {
      // Yield once so a StrictMode mount/unmount/mount never starts a load on the viewer being disposed
      // (that load gets aborted with an unhandled "Scene disposed" rejection).
      await Promise.resolve()
      if (cancelled) return
      if (viewer.isLoadingOrUnloading()) await waitUntil(() => !viewer.isLoadingOrUnloading())
      if (viewer.getSceneCount() > 0) await viewer.removeSplatScene(0, false)
      if (cancelled || !source) {
        setState({ kind: 'idle' })
        return
      }
      setState({ kind: 'loading', progress: 0, label: name })
      try {
        // A missing file gets Next's 404 page (text/html), which the parser
        // happily turns into a handful of garbage splats. Check first so a bad path reports an error.
        if (!source.startsWith('blob:')) {
          const head = await fetch(source, { method: 'HEAD' })
          if (!head.ok || head.headers.get('content-type')?.includes('text/html')) {
            throw new Error(`Scene not found: ${source}`)
          }
          if (cancelled) return
        }
        await viewer.addSplatScene(source, {
          format: formatFromName(name),
          showLoadingUI: false,
          progressiveLoad: false,
          splatAlphaRemovalThreshold: 5,
          onProgress: (percent: number) => {
            if (!cancelled) setState({ kind: 'loading', progress: percent, label: name })
          },
        })
        if (cancelled) return
        if (!viewer.selfDrivenModeRunning) viewer.start()
        viewer.setRenderMode(GaussianSplats3D.RenderMode.OnChange)
        const scene = viewer.getSplatScene(0)
        setState({ kind: 'ready', label: name, splats: scene?.splatBuffer?.getSplatCount?.() ?? 0 })
      } catch (err) {
        if (cancelled) return
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [source, label])

  const resetCamera = () => {
    const viewer = viewerRef.current
    if (!viewer) return
    const camera = viewer.camera as THREE.PerspectiveCamera
    camera.position.set(...CAMERA_POSITION)
    camera.up.set(0, -1, 0)
    viewer.controls?.target.set(...CAMERA_LOOK_AT)
    viewer.controls?.update()
    viewer.forceRenderNextFrame()
  }

  const topDown = () => {
    const viewer = viewerRef.current
    if (!viewer) return
    const camera = viewer.camera as THREE.PerspectiveCamera
    camera.position.set(0, -4, 0.01)
    viewer.controls?.target.set(0, 0, 0)
    viewer.controls?.update()
    viewer.forceRenderNextFrame()
  }

  return (
    <section className="relative flex h-full min-h-[320px] flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      <div ref={mountRef} className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Gaussian splat viewer</span>
        <span className="rounded-full bg-zinc-800/80 px-2.5 py-0.5 text-xs text-zinc-300">
          {state.kind === 'ready' && `${state.label} · ${state.splats.toLocaleString()} splats`}
          {state.kind === 'loading' && `loading ${state.label} ${Math.round(state.progress)}%`}
          {state.kind === 'error' && 'load failed'}
          {state.kind === 'idle' && 'no scene'}
        </span>
      </div>

      {state.kind !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          {state.kind === 'idle' && (
            <>
              <div className="text-5xl text-zinc-700">◌</div>
              <p className="max-w-sm text-sm text-zinc-400">
                Load a splat from the Scene panel, or run the pipeline on captured images to make one.
              </p>
            </>
          )}
          {state.kind === 'loading' && (
            <div className="h-1.5 w-48 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full bg-sky-400 transition-[width]" style={{ width: `${state.progress}%` }} />
            </div>
          )}
          {state.kind === 'error' && <p className="max-w-sm text-sm text-red-300">{state.message}</p>}
        </div>
      )}

      <div className="absolute right-3 bottom-3 flex gap-2">
        <button
          type="button"
          onClick={topDown}
          disabled={state.kind !== 'ready'}
          className="rounded-md bg-zinc-800/90 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          Bird's-eye
        </button>
        <button
          type="button"
          onClick={resetCamera}
          disabled={state.kind !== 'ready'}
          className="rounded-md bg-zinc-800/90 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          Reset view
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 text-[11px] text-zinc-500">
        drag to orbit · scroll to zoom · right-drag to pan
      </p>
    </section>
  )
}

function formatFromName(name: string): GaussianSplats3D.SceneFormat | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.ply')) return GaussianSplats3D.SceneFormat.Ply
  if (lower.endsWith('.ksplat')) return GaussianSplats3D.SceneFormat.KSplat
  if (lower.endsWith('.spz')) return GaussianSplats3D.SceneFormat.Spz
  if (lower.endsWith('.splat')) return GaussianSplats3D.SceneFormat.Splat
  return undefined
}

function waitUntil(pred: () => boolean, intervalMs = 50): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (pred() ? resolve() : setTimeout(tick, intervalMs))
    tick()
  })
}
