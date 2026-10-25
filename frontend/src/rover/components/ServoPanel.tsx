import type { PointerEvent } from 'react'
import { SERVO_US, type Jog, type Servo, type StatusReport } from '../protocol'
import { Hint, Kbd, Readout } from '../ui/kit'
import { Module } from '../ui/layout'
import { PercentSlider } from './PercentSlider'

interface ServoPanelProps {
  jogs: Record<Servo, Jog>
  status: StatusReport | null
  speed: number
  connected: boolean
  onJog: (servo: Servo, jog: Jog) => void
  onSpeed: (speed: number) => void
}

const SERVO_LABEL: Record<Servo, { title: string; gpio: number; keys: [string, string] }> = {
  pan: { title: 'Pan', gpio: 19, keys: ['Q', 'E'] },
  lift: { title: 'Lift', gpio: 18, keys: ['F', 'R'] },
}

/**
 * The arm's two servos, jogged while a button (or key) is held: the firmware moves the commanded
 * pulse at the servo speed and holds wherever it is let go. There is no arm sequence on this
 * firmware and no angle feedback, so the readouts are commanded µs, not positions.
 */
export function ServoPanel({ jogs, status, speed, connected, onJog, onSpeed }: ServoPanelProps) {
  const jogging = jogs.pan !== 0 || jogs.lift !== 0

  const button = (servo: Servo, jog: Exclude<Jog, 0>) => {
    const label = `${SERVO_LABEL[servo].title} ${jog > 0 ? 'forward' : 'back'}`
    const key = SERVO_LABEL[servo].keys[jog > 0 ? 1 : 0]
    const isHeld = jogs[servo] === jog
    const down = (e: PointerEvent<HTMLButtonElement>) => {
      if (!connected) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      onJog(servo, jog)
    }
    const up = () => {
      if (jogs[servo] === jog) onJog(servo, 0)
    }
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={isHeld}
        aria-keyshortcuts={key}
        disabled={!connected}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
        onContextMenu={(e) => e.preventDefault()}
        className={[
          'flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-[13px] font-medium transition-[background-color,border-color,color,transform] duration-100 select-none',
          !connected
            ? 'cursor-not-allowed border-line bg-well text-ink-3 opacity-60'
            : isHeld
              ? 'translate-y-px border-ink bg-ink text-panel'
              : 'border-line border-b-[3px] bg-panel text-ink hover:border-line-strong active:translate-y-px active:border-b',
        ].join(' ')}
      >
        <span aria-hidden>{jog > 0 ? '▶' : '◀'}</span>
        {jog > 0 ? 'Forward' : 'Back'}
        <span className={`num text-[10px] ${isHeld ? 'text-panel/70' : 'text-ink-3'}`}>{key}</span>
      </button>
    )
  }

  const pulse = (servo: Servo) => {
    const us = status?.[servo]
    return us === undefined ? '—' : `${us} µs`
  }

  return (
    <Module id="arm" title="Arm" meta={jogging ? 'jogging' : connected ? 'holding' : 'off'}>
      <div className="flex flex-col gap-3">
        {(['pan', 'lift'] as const).map((servo) => (
          <div key={servo} role="group" aria-label={`${SERVO_LABEL[servo].title} servo`}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[13px] text-ink-2">
                {SERVO_LABEL[servo].title} <span className="text-ink-3">· GPIO {SERVO_LABEL[servo].gpio}</span>
              </span>
              <span className="num text-[13px] text-ink">{pulse(servo)}</span>
            </div>
            <div className="flex gap-1.5">
              {button(servo, -1)}
              {button(servo, 1)}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <PercentSlider
          id="servo-speed"
          label="Servo speed"
          value={speed}
          onChange={onSpeed}
          hint={speed === 100 ? 'At 100 % a press goes straight to the endpoint.' : speed === 0 ? 'At 0 % the servos will not move.' : `Jogs about ${speed * SERVO_US_PER_SECOND} µs per second.`}
        />
      </div>

      <dl className="mt-2">
        <Readout label="Range">
          <span className="num">
            {SERVO_US.min}–{SERVO_US.max} µs
          </span>
        </Readout>
      </dl>
      <Hint className="mt-2">
        Hold to jog; let go and the servo holds there, even if the link drops. The µs are what's commanded, not a measured angle, and the
        range is electrical, not what the arm can safely reach. No arm sequence on this firmware. <Kbd>Q</Kbd> <Kbd>E</Kbd> pan, <Kbd>F</Kbd>{' '}
        <Kbd>R</Kbd> lift.
      </Hint>
    </Module>
  )
}

const SERVO_US_PER_SECOND = 20
