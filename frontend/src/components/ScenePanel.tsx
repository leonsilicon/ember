import { useRef } from 'react'
import { BANANA_SPLAT_URL, SAMPLE_SPLAT_URL } from './SplatViewer'

export type SceneSource = { url: string; label: string } | null

/** Scene shown when the page opens: generated leaf-covered ground (scripts/make-leaf-splat.mjs). */
export const DEFAULT_SCENE: SceneSource = { url: SAMPLE_SPLAT_URL, label: 'leaf floor (sample)' }

type Props = {
  scene: SceneSource
  onChange: (scene: SceneSource) => void
}

export function ScenePanel({ scene, onChange }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)

  const pickFile = (file: File | undefined) => {
    if (!file) return
    if (scene?.url.startsWith('blob:')) URL.revokeObjectURL(scene.url)
    onChange({ url: URL.createObjectURL(file), label: file.name })
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Scene</h2>
        <span className="max-w-[55%] truncate font-mono text-xs text-zinc-400">{scene?.label ?? 'none'}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange(DEFAULT_SCENE)}
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700"
        >
          Leaf floor
        </button>
        <button
          type="button"
          onClick={() => onChange({ url: BANANA_SPLAT_URL, label: 'banana (sample)' })}
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700"
        >
          Banana
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700"
        >
          Open .splat / .ply…
        </button>
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={!scene}
          className="rounded-md px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
        >
          Clear
        </button>
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
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const url = urlInput.current?.value.trim()
          if (url) onChange({ url, label: url.split('/').pop() ?? url })
        }}
      >
        <input
          ref={urlInput}
          type="text"
          placeholder="/splats/scene.splat"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500"
        />
        <button type="submit" className="rounded-md bg-zinc-800 px-3 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-700">
          Load URL
        </button>
      </form>
      <p className="mt-3 text-xs text-zinc-500">
        Make a scene with <span className="font-mono">pipeline/reconstruct.py &lt;images&gt;</span>, then drop the
        output into <span className="font-mono">frontend/public/splats/</span> or open it here.
      </p>
    </section>
  )
}
