interface StopButtonProps {
  disabled: boolean
  onStop: () => void
}

export function StopButton({ disabled, onStop }: StopButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onStop}
      className={[
        'w-full rounded-xl border-2 py-5 text-2xl font-black tracking-widest uppercase transition',
        'focus:outline-none focus-visible:ring-4 focus-visible:ring-red-300',
        disabled
          ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-600'
          : 'border-red-400 bg-red-600 text-white shadow-lg shadow-red-600/40 hover:bg-red-500 active:bg-red-700',
      ].join(' ')}
    >
      Stop
      <span className="mt-1 block text-[11px] font-medium tracking-normal normal-case opacity-80">
        Space / Esc
      </span>
    </button>
  )
}
