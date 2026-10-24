import type { PointerEvent } from 'react'
import type { Direction, DriveCommand } from '../protocol'

interface DPadProps {
  held: Direction | null
  reportedDrive: DriveCommand
  disabled: boolean
  onPress: (direction: Direction) => void
  onRelease: (direction: Direction) => void
}

const LABELS: Record<Direction, { glyph: string; key: string; label: string }> = {
  forward: { glyph: '▲', key: 'W', label: 'Forward' },
  back: { glyph: '▼', key: 'S', label: 'Back' },
  left: { glyph: '◀', key: 'A', label: 'Left' },
  right: { glyph: '▶', key: 'D', label: 'Right' },
}

export function DPad({ held, reportedDrive, disabled, onPress, onRelease }: DPadProps) {
  const button = (direction: Direction, extra: string) => {
    const { glyph, key, label } = LABELS[direction]
    const isHeld = held === direction
    const isReported = reportedDrive === direction
    const handleDown = (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      onPress(direction)
    }
    const handleUp = () => onRelease(direction)
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={isHeld}
        disabled={disabled}
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onLostPointerCapture={handleUp}
        onContextMenu={(e) => e.preventDefault()}
        className={[
          extra,
          'relative flex h-20 w-20 flex-col items-center justify-center rounded-xl border text-2xl transition select-none',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          disabled
            ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-600'
            : isHeld
              ? 'border-sky-400 bg-sky-500 text-white shadow-lg shadow-sky-500/40'
              : 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 active:bg-sky-600',
        ].join(' ')}
      >
        <span>{glyph}</span>
        <span className="mt-1 text-[10px] font-medium tracking-wide text-zinc-400">{key}</span>
        {isReported && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-emerald-400"
            title="Device reports this direction active"
          />
        )}
      </button>
    )
  }

  return (
    <div className="grid grid-cols-3 grid-rows-3 gap-2" role="group" aria-label="Drive controls">
      {button('forward', 'col-start-2 row-start-1')}
      {button('left', 'col-start-1 row-start-2')}
      <div className="col-start-2 row-start-2 flex items-center justify-center text-xs text-zinc-500">
        hold
      </div>
      {button('right', 'col-start-3 row-start-2')}
      {button('back', 'col-start-2 row-start-3')}
    </div>
  )
}
