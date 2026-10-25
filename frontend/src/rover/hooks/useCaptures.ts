import { useCallback, useEffect, useState } from 'react'
import type { Job } from '#jobs.ts'

export type CapturesState =
  | { kind: 'loading' }
  | { kind: 'ready'; captures: Job[] }
  | { kind: 'error'; message: string }

/** A capture has a splat to show once training has written its first snapshot. */
export const viewable = (job: Job) => job.step > 0 && job.state !== 'cancelled'

/**
 * The splat captures the phone uploaded and the Mac trained (the Live 3D page's Captures module), from the same API:
 * `GET /api/captures`, signed in by the page's session cookie. Newest first.
 */
export function useCaptures() {
  const [state, setState] = useState<CapturesState>({ kind: 'loading' })

  const refresh = useCallback(async () => {
    setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' }))
    try {
      const response = await fetch('/api/captures', { cache: 'no-store' })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `the server answered ${response.status}`)
      }
      const { captures } = (await response.json()) as { captures: Job[] }
      captures.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setState({ kind: 'ready', captures })
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  return { state, refresh }
}

type Transforms = { frames: { transform_matrix: number[][] }[] }

/**
 * The scene for a capture's newest splat, with the camera where the phone started: ARKit's world is
 * gravity-aligned with +y up, so the first frame's pose is used as-is, looking at the seed cloud's
 * focus (the same placement as the full-page viewer, app/(splat)/view/[id]/splat-scene.ts).
 */
export async function captureScene(job: Job) {
  const transforms = (await fetch(`/api/captures/${job.id}/transforms.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as Transforms | null
  const m = transforms?.frames[0]?.transform_matrix
  let position: [number, number, number] = [0, 0, 2]
  let lookAt: [number, number, number] = job.focus ?? [0, 0, 0]
  if (m) {
    position = [m[0][3], m[1][3], m[2][3]]
    if (!job.focus) {
      const f = [-m[0][2], -m[1][2], -m[2][2]]
      const len = Math.hypot(f[0], f[1], f[2]) || 1
      lookAt = [position[0] + (f[0] / len) * 1.5, position[1] + (f[1] / len) * 1.5, position[2] + (f[2] / len) * 1.5]
    }
  }
  return {
    url: `/api/captures/${encodeURIComponent(job.id)}/splat.ply?step=${job.step}`,
    label: job.id,
    format: 'ply' as const,
    captureId: job.id,
    camera: { up: [0, 1, 0] as [number, number, number], position, lookAt },
  }
}
