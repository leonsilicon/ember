import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { IconButton, Icons } from '../ui/kit'

export const SAMPLE_SPLAT_URL = '/splats/leaf-floor.splat'

type Vec3 = [number, number, number]
export type SceneCamera = { up: Vec3; position: Vec3; lookAt: Vec3 }
export type SceneFormat = 'ply' | 'splat' | 'ksplat'

// The sample's convention: ground is the y=0 plane and up is -y. The default view looks down at ~35°
// onto the middle of the ~4.6 m leaf-floor sample. Captures bring their own camera (+y up, ARKit).
export const SAMPLE_CAMERA: SceneCamera = { up: [0, -1, 0], position: [0, -1.45, -2.25], lookAt: [0, 0, 0.2] }

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
  /** File format, when the URL doesn't end in one (the captures API). */
  format?: SceneFormat
  /** Where the camera starts. Read once: give the viewer a new `key` to change it. */
  camera?: SceneCamera
}

const FORMATS: Record<SceneFormat, GaussianSplats3D.SceneFormat> = {
  ply: GaussianSplats3D.SceneFormat.Ply,
  splat: GaussianSplats3D.SceneFormat.Splat,
  ksplat: GaussianSplats3D.SceneFormat.KSplat,
}

export function SplatViewer({ source, label, format, camera = SAMPLE_CAMERA }: Props) {
  const cameraRef = useRef(camera)
  const mountRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<GaussianSplats3D.Viewer | null>(null)
  const [state, setState] = useState<LoadState>({ kind: 'idle' })

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const viewer = new GaussianSplats3D.Viewer({
      rootElement: mount,
      cameraUp: cameraRef.current.up,
      initialCameraPosition: cameraRef.current.position,
      initialCameraLookAt: cameraRef.current.lookAt,
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
        // (The captures API answers JSON errors, and a HEAD there would stream the whole splat.)
        if (!source.startsWith('blob:') && !source.startsWith('/api/')) {
          const head = await fetch(source, { method: 'HEAD' })
          if (!head.ok || head.headers.get('content-type')?.includes('text/html')) {
            throw new Error(`Scene not found: ${source}`)
          }
          if (cancelled) return
        }
        await viewer.addSplatScene(source, {
          format: format ? FORMATS[format] : formatFromName(name),
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
  }, [source, label, format])

  const resetCamera = () => {
    const viewer = viewerRef.current
    if (!viewer) return
    const camera = viewer.camera as THREE.PerspectiveCamera
    const { up, position, lookAt } = cameraRef.current
    camera.position.set(...position)
    camera.up.set(...up)
    viewer.controls?.target.set(...lookAt)
    viewer.controls?.update()
    viewer.forceRenderNextFrame()
  }

  const topDown = () => {
    const viewer = viewerRef.current
    if (!viewer) return
    const camera = viewer.camera as THREE.PerspectiveCamera
    // Straight down onto what the view orbits, from 4 m up (a hair off-axis so the orbit stays defined).
    const { up, lookAt } = cameraRef.current
    camera.position.set(lookAt[0] + up[0] * 4 + 0.01, lookAt[1] + up[1] * 4, lookAt[2] + up[2] * 4 + 0.01)
    viewer.controls?.target.set(...lookAt)
    viewer.controls?.update()
    viewer.forceRenderNextFrame()
  }

  const statusText =
    state.kind === 'ready'
      ? `${state.splats.toLocaleString()} splats`
      : state.kind === 'loading'
        ? `loading ${Math.round(state.progress)}%`
        : state.kind === 'error'
          ? 'load failed'
          : 'no scene'

  return (
    <section aria-label="Scene viewer" className="absolute inset-0">
      <div ref={mountRef} className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full" />

      <div className="pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-5rem)] items-center gap-2.5 rounded-[10px] border border-line bg-panel/95 px-3 py-2 shadow-float backdrop-blur-sm">
        <span className="text-[11px] font-semibold tracking-[0.14em] text-ink uppercase">Scene</span>
        <span className="truncate text-[13px] text-ink-2">{state.kind === 'ready' || state.kind === 'loading' ? state.label : (label ?? '—')}</span>
        <span className="num shrink-0 text-xs text-ink-3">{statusText}</span>
      </div>

      {state.kind !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          {state.kind === 'idle' && (
            <>
              <span aria-hidden className="block h-px w-16 bg-[#3a3734]" />
              <p className="max-w-sm text-[13px] leading-relaxed text-[#a8a29a]">
                No scene loaded. Pick one in the Scene panel, or run the pipeline on captured images to make one.
              </p>
            </>
          )}
          {state.kind === 'loading' && (
            <div className="h-1 w-56 overflow-hidden rounded-full bg-[#2a2826]" role="progressbar" aria-valuenow={Math.round(state.progress)} aria-valuemin={0} aria-valuemax={100} aria-label="Loading scene">
              <div className="h-full bg-ember transition-[width] duration-200" style={{ width: `${state.progress}%` }} />
            </div>
          )}
          {state.kind === 'error' && <p className="max-w-sm text-[13px] text-[#ff8a7a]">{state.message}</p>}
        </div>
      )}

      <div className="absolute top-3 right-3 flex flex-col gap-0.5 rounded-[10px] border border-line bg-panel/95 p-1 shadow-float backdrop-blur-sm" role="toolbar" aria-label="Camera" aria-orientation="vertical">
        <IconButton label="Bird's-eye view" onClick={topDown} disabled={state.kind !== 'ready'}>
          <Icons.topDown />
        </IconButton>
        <IconButton label="Reset view" onClick={resetCamera} disabled={state.kind !== 'ready'}>
          <Icons.resetView />
        </IconButton>
      </div>
      <p className="pointer-events-none absolute right-3 bottom-3 hidden text-[11px] text-white/55 md:block">drag to orbit · scroll to zoom · right-drag to pan</p>
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
