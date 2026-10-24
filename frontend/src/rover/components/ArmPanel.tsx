import type { ArmState } from '../protocol'

interface ArmPanelProps {
  arm: ArmState
  connected: boolean
  onRun: () => void
}

const ARM_STYLES: Record<ArmState, string> = {
  idle: 'bg-zinc-700 text-zinc-200',
  running: 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/60',
  completed: 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/60',
  error: 'bg-red-500/20 text-red-300 ring-1 ring-red-400/60',
}

export function ArmPanel({ arm, connected, onRun }: ArmPanelProps) {
  const running = arm === 'running'
  const disabled = !connected || running
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Arm</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${ARM_STYLES[arm]}`}>
          {running && <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />}
          {arm}
        </span>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onRun}
        className={[
          'w-full rounded-lg px-4 py-3 text-base font-semibold transition',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300',
          disabled
            ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
            : 'bg-violet-600 text-white hover:bg-violet-500 active:bg-violet-700',
        ].join(' ')}
      >
        {running ? 'Sequence running…' : 'Run arm sequence'}
      </button>
      <p className="mt-2 text-xs text-zinc-500">Triggers the single predefined sequence once. Ignored while running.</p>
    </section>
  )
}
