import type { ReactNode } from 'react'
import { Field } from '../ui/kit'

interface PercentSliderProps {
  id: string
  label: ReactNode
  value: number
  onChange: (value: number) => void
  hint?: ReactNode
  disabled?: boolean
}

/** A 0..100 % setting the rover takes as an integer (wheel PWM duty, servo jog rate). */
export function PercentSlider({ id, label, value, onChange, hint, disabled }: PercentSliderProps) {
  return (
    <Field label={label} htmlFor={id} value={<span className="num text-[13px] text-ink">{value} %</span>} hint={hint}>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuetext={`${value} percent`}
        onChange={(e) => onChange(Math.round(Number(e.target.value)))}
        className="w-full"
      />
    </Field>
  )
}
