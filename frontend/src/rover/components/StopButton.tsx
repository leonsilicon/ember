import { Kbd } from '../ui/kit'

interface StopButtonProps {
  disabled: boolean
  onStop: () => void
  /** The top bar's small one, always in reach. */
  compact?: boolean
}

export function StopButton({ disabled, onStop, compact }: StopButtonProps) {
  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onStop}
        aria-keyshortcuts="Space Escape"
        className="inline-flex h-8 items-center gap-2 rounded-md bg-danger px-3 text-xs font-semibold tracking-[0.12em] text-white uppercase transition-colors hover:bg-danger-hover disabled:pointer-events-none disabled:opacity-40"
      >
        <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-white" />
        Stop
      </button>
    )
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onStop}
      aria-keyshortcuts="Space Escape"
      className="flex w-full items-center justify-between rounded-xl bg-danger px-5 py-4 text-white transition-colors hover:bg-danger-hover active:brightness-95 disabled:cursor-not-allowed disabled:bg-well disabled:text-ink-3"
    >
      <span className="flex items-center gap-3">
        <span aria-hidden className={`h-4 w-4 rounded-[3px] ${disabled ? 'bg-line-strong' : 'bg-white'}`} />
        <span className="text-lg font-semibold tracking-[0.2em] uppercase">Stop</span>
      </span>
      <span className="flex gap-1 opacity-90">
        <Kbd>Space</Kbd>
        <Kbd>Esc</Kbd>
      </span>
    </button>
  )
}
