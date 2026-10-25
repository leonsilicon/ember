import { useRef, useState } from 'react'
import type { Job } from '#jobs.ts'
import { captureScene, viewable, type CapturesState } from '../hooks/useCaptures'
import { Button, Hint, IconButton, Icons, INPUT, Led, type Tone } from '../ui/kit'
import { Module } from '../ui/layout'
import { SAMPLE_SPLAT_URL, type SceneCamera, type SceneFormat } from './SplatViewer'

export type SceneSource = { url: string; label: string; format?: SceneFormat; camera?: SceneCamera; captureId?: string } | null

/** Generated leaf-covered ground (scripts/make-leaf-splat.mjs): shown until a capture loads, or without any. */
export const DEFAULT_SCENE: SceneSource = { url: SAMPLE_SPLAT_URL, label: 'leaf floor (sample)' }

type Props = {
  scene: SceneSource
  onChange: (scene: SceneSource) => void
  captures: CapturesState
  onRefresh: () => void
}

const STATE_TONE: Partial<Record<Job['state'], Tone>> = { done: 'ok', training: 'live', paused: 'warn', failed: 'danger' }

function when(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function ScenePanel({ scene, onChange, captures, onRefresh }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState<string | null>(null)

  const pickFile = (file: File | undefined) => {
    if (!file) return
    if (scene?.url.startsWith('blob:')) URL.revokeObjectURL(scene.url)
    onChange({ url: URL.createObjectURL(file), label: file.name })
  }

  const openCapture = async (job: Job) => {
    setOpening(job.id)
    try {
      onChange(await captureScene(job))
    } finally {
      setOpening(null)
    }
  }

  const list = captures.kind === 'ready' ? captures.captures.filter(viewable) : []
  const meta = captures.kind === 'ready' ? `${list.length} capture${list.length === 1 ? '' : 's'}` : captures.kind === 'loading' ? 'loading…' : 'offline'

  return (
    <Module
      id="scene"
      title="Scene"
      meta={meta}
      actions={
        <IconButton label="Refresh captures" onClick={onRefresh} className="h-7 w-7">
          <Icons.restart />
        </IconButton>
      }
    >
      <div className="-mx-1.5">
        {captures.kind === 'loading' && (
          <div className="flex flex-col gap-1.5 px-1.5" aria-label="Loading captures">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-10 animate-pulse rounded-md bg-well" />
            ))}
          </div>
        )}
        {captures.kind === 'error' && (
          <p className="mx-1.5 rounded-md border border-line bg-well px-3 py-2 text-xs leading-relaxed text-ink-2">
            Couldn't list the captures: <span className="text-danger">{captures.message}</span>. They're stored with the deployed app; a
            local server needs its Redis and Blob settings (<span className="num">vercel env pull</span>).
          </p>
        )}
        {captures.kind === 'ready' && list.length === 0 && (
          <p className="mx-1.5 text-xs leading-relaxed text-ink-3">No trained captures yet. Record one in the app; it shows here once the Mac has trained a first snapshot.</p>
        )}
        {list.length > 0 && (
          <ul className="flex max-h-64 flex-col overflow-y-auto" aria-label="Captures">
            {list.map((job) => {
              const current = scene?.captureId === job.id
              return (
                <li key={job.id}>
                  <button
                    type="button"
                    aria-pressed={current}
                    disabled={opening != null}
                    onClick={() => void openCapture(job)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors disabled:cursor-wait ${current ? 'bg-ember-soft' : 'hover:bg-well'}`}
                  >
                    <Led tone={STATE_TONE[job.state] ?? 'off'} blink={opening === job.id} />
                    <span className="min-w-0 flex-1">
                      <span className="num block truncate text-[13px] text-ink">{job.id}</span>
                      <span className="block truncate text-[11px] text-ink-3">
                        {job.state === 'done' ? 'trained' : job.state}
                        {job.gaussians ? ` · ${job.gaussians.toLocaleString()} gaussians` : ''} · {when(job.createdAt)}
                      </span>
                    </span>
                    {current && <span className="text-[11px] font-medium text-ember-ink">Showing</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <Button size="sm" onClick={() => onChange(DEFAULT_SCENE)} aria-pressed={scene?.url === SAMPLE_SPLAT_URL}>
          Leaf floor sample
        </Button>
        <Button size="sm" onClick={() => fileInput.current?.click()}>
          <Icons.folder />
          Open file…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)} disabled={!scene}>
          Clear
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".splat,.ply,.ksplat"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const url = urlInput.current?.value.trim()
          if (url) onChange({ url, label: url.split('/').pop() ?? url })
        }}
      >
        <label htmlFor="scene-url" className="sr-only">
          Scene URL
        </label>
        <input id="scene-url" ref={urlInput} type="text" placeholder="/splats/scene.splat" spellCheck={false} className={`${INPUT} num flex-1`} />
        <Button type="submit">Load URL</Button>
      </form>
      <Hint className="mt-3">Captures are the phone's recordings, trained into splats on the Mac. The newest opens by itself.</Hint>
    </Module>
  )
}
