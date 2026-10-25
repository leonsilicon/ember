import type { PointerEvent } from 'react'
import type { Direction, DriveCommand } from '../protocol'
import { Icons } from '../ui/kit'

interface DPadProps {
  held: Direction | null
  reportedDrive: DriveCommand
  disabled: boolean
  onPress: (direction: Direction) => void
  onRelease: (direction: Direction) => void
  /** The autopilot is pressing the buttons. */
  auto?: boolean
}

const LABELS: Record<Direction, { rotate: number; key: string; label: string }> = {
  forward: { rotate: 0, key: 'W', label: 'Forward' },
  back: { rotate: 180, key: 'S', label: 'Back' },
  left: { rotate: -90, key: 'A', label: 'Left' },
  right: { rotate: 90, key: 'D', label: 'Right' },
}

export function DPad({ held, reportedDrive, disabled, onPress, onRelease, auto }: DPadProps) {
  const button = (direction: Direction, extra: string) => {
    const { rotate, key, label } = LABELS[direction]
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
        aria-keyshortcuts={key}
        disabled={disabled}
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onLostPointerCapture={handleUp}
        onContextMenu={(e) => e.preventDefault()}
        className={[
          extra,
          'relative flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-xl border transition-[background-color,border-color,color,transform] duration-100 select-none',
          disabled
            ? 'cursor-not-allowed border-line bg-well text-ink-3 opacity-60'
            : isHeld
              ? 'translate-y-px border-ink bg-ink text-panel'
              : 'border-line border-b-[3px] bg-panel text-ink hover:border-line-strong active:translate-y-px active:border-b',
        ].join(' ')}
      >
        <span style={{ transform: `rotate(${rotate}deg)` }}>
          <Icons.arrow />
        </span>
        <span className={`num text-[10px] ${isHeld ? 'text-panel/70' : 'text-ink-3'}`}>{key}</span>
        {isReported && <span aria-hidden className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-[1px] bg-ok" title="The rover reports this direction" />}
      </button>
    )
  }

  return (
    <div className="grid grid-cols-3 grid-rows-3 gap-1.5" role="group" aria-label="Drive controls">
      {button('forward', 'col-start-2 row-start-1')}
      {button('left', 'col-start-1 row-start-2')}
      <div className={`col-start-2 row-start-2 flex flex-col items-center justify-center rounded-xl text-center ${auto ? 'bg-ember-soft' : 'bg-well'}`}>
        <span className={`text-[10px] tracking-[0.12em] uppercase ${auto ? 'font-semibold text-ember-ink' : 'text-ink-3'}`}>{auto ? 'auto' : 'rover'}</span>
        <span className="num text-xs text-ink">{reportedDrive}</span>
      </div>
      {button('right', 'col-start-3 row-start-2')}
      {button('back', 'col-start-2 row-start-3')}
    </div>
  )
}
