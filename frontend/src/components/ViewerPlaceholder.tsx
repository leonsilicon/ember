export function ViewerPlaceholder() {
  return (
    <div className="flex h-full min-h-[320px] flex-col gap-3">
      <section className="relative flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-[radial-gradient(ellipse_at_center,_rgba(56,189,248,0.08),_transparent_60%)] p-6 text-center">
        <span className="absolute top-3 left-4 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
          Gaussian splat viewer
        </span>
        <div className="mb-3 text-5xl text-zinc-700">◌</div>
        <p className="max-w-sm text-sm text-zinc-400">
          The reconstructed scene will render here with orbit, zoom and a bird's-eye view once a splat has been
          generated from captured images.
        </p>
        <p className="mt-2 text-xs text-zinc-600">Milestone 2 — no renderer loaded yet.</p>
      </section>
      <section className="flex h-28 items-center justify-between rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4">
        <div>
          <div className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Live camera</div>
          <div className="text-sm text-zinc-500">Preview not available — camera model and stream are undecided.</div>
        </div>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">offline</span>
      </section>
    </div>
  )
}
