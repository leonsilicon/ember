import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * The Ember instrument kit: the few controls every rover page is built from. Colours come from the
 * tokens in app/(rover)/rover.css, so everything here follows light and dark mode.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ember text-[#1c1917] hover:bg-ember-hover active:brightness-95',
  secondary: 'border border-line bg-panel text-ink hover:border-line-strong hover:bg-well active:bg-well',
  ghost: 'text-ink-2 hover:bg-well hover:text-ink',
  danger: 'bg-danger text-white hover:bg-danger-hover active:brightness-95',
}
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
  md: 'h-8 gap-1.5 rounded-md px-3 text-[13px]',
  lg: 'h-10 gap-2 rounded-lg px-4 text-sm',
}

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = '') {
  return `inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-150 select-none disabled:pointer-events-none disabled:opacity-45 ${VARIANT[variant]} ${SIZE[size]} ${extra}`
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />
}

/** A square icon-only button; `label` is its accessible name and tooltip. */
export function IconButton({
  label,
  pressed,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-2 transition-colors duration-150 hover:bg-well hover:text-ink disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-ink aria-pressed:text-panel ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export const INPUT =
  'h-8 min-w-0 rounded-md border border-line bg-well px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-line-strong focus-visible:border-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft'

/** A row of mutually exclusive choices, like a hardware selector switch. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  render = (v) => String(v),
  size = 'md',
  className = '',
}: {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  label: string
  render?: (value: T) => ReactNode
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={`inline-flex rounded-md border border-line bg-well p-0.5 ${className}`}>
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`flex-1 rounded-[5px] font-medium transition-colors duration-150 ${size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]'} ${
            value === option ? 'bg-panel text-ink shadow-[0_1px_2px_rgb(28_25_23/0.12)]' : 'text-ink-2 hover:text-ink'
          }`}
        >
          {render(option)}
        </button>
      ))}
    </div>
  )
}

export type Tone = 'off' | 'ok' | 'warn' | 'danger' | 'live' | 'info'
const TONE_BG: Record<Tone, string> = {
  off: 'bg-line-strong',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  live: 'bg-ember',
  info: 'bg-info',
}

/** A square status lamp. Never the only carrier of state: always set beside a word. */
export function Led({ tone, blink, className = '' }: { tone: Tone; blink?: boolean; className?: string }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-[2px] ${TONE_BG[tone]} ${blink ? 'led-blink' : ''} ${className}`} />
}

/** A segmented meter: one cell per item, the first `filled` lit. */
export function Meter({ count, filled, color, label }: { count: number; filled: number; color: string; label: ReactNode }) {
  const cells = Math.max(count, 1)
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex min-w-0 flex-1 gap-[2px]" aria-hidden>
        {Array.from({ length: cells }, (_, i) => (
          <span
            key={i}
            className="h-1.5 min-w-[3px] flex-1 rounded-[1px] transition-colors duration-200"
            style={{ background: i < filled ? color : 'var(--line)' }}
          />
        ))}
      </div>
      <span className="num shrink-0 text-xs text-ink-2">{label}</span>
    </div>
  )
}

/** A key cap, for shortcut hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="num inline-grid h-5 min-w-5 place-items-center rounded border border-line border-b-2 bg-panel px-1 text-[11px] font-medium text-ink-2">
      {children}
    </kbd>
  )
}

/** A label/value pair in a readout list. */
export function Readout({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: 'danger' | 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 [&+&]:border-t [&+&]:border-line">
      <dt className="text-[13px] text-ink-2">{label}</dt>
      <dd className={`num text-right text-[13px] ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ink'}`}>{children}</dd>
    </div>
  )
}

/** Small explanatory text under a control. */
export function Hint({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs leading-snug text-ink-3 ${className}`}>{children}</p>
}

/** A labelled control row inside a module. */
export function Field({ label, htmlFor, value, children, hint }: { label: ReactNode; htmlFor?: string; value?: ReactNode; children?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
            {label}
          </label>
        ) : (
          <span className="text-[13px] font-medium text-ink">{label}</span>
        )}
        {value}
      </div>
      {children}
      {hint && <Hint>{hint}</Hint>}
    </div>
  )
}

/** Icons: 16px, 1.75px stroke, round caps (lucide geometry). */
export function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const Icons = {
  play: () => (
    <Icon>
      <path d="M7 4.5v15a.5.5 0 0 0 .76.43l12.5-7.5a.5.5 0 0 0 0-.86L7.76 4.07A.5.5 0 0 0 7 4.5Z" fill="currentColor" />
    </Icon>
  ),
  pause: () => (
    <Icon>
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" />
    </Icon>
  ),
  restart: () => (
    <Icon>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Icon>
  ),
  minus: () => (
    <Icon>
      <path d="M5 12h14" />
    </Icon>
  ),
  plus: () => (
    <Icon>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  ),
  pin: () => (
    <Icon>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </Icon>
  ),
  chevron: () => (
    <Icon>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  ),
  dock: () => (
    <Icon>
      <path d="M5 12h14" />
    </Icon>
  ),
  panel: () => (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Icon>
  ),
  keyboard: () => (
    <Icon>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </Icon>
  ),
  sun: () => (
    <Icon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Icon>
  ),
  moon: () => (
    <Icon>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Icon>
  ),
  monitor: () => (
    <Icon>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Icon>
  ),
  follow: () => (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  ),
  topDown: () => (
    <Icon>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 12h16M12 4v16" />
    </Icon>
  ),
  resetView: () => (
    <Icon>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="2" />
    </Icon>
  ),
  close: () => (
    <Icon>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  ),
  folder: () => (
    <Icon>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  ),
  camera: () => (
    <Icon>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3" />
    </Icon>
  ),
  record: () => (
    <Icon>
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </Icon>
  ),
  square: () => (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
    </Icon>
  ),
  logOut: () => (
    <Icon>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </Icon>
  ),
  download: () => (
    <Icon>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Icon>
  ),
  arrow: () => (
    <Icon size={20}>
      <path d="m6 14 6-6 6 6" />
    </Icon>
  ),
}
