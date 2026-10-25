import Link from 'next/link'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Dock, LayoutProvider, Rail, useLayout } from './layout'
import { IconButton, Icons, Kbd } from './kit'
import { useTheme } from './theme'

const PAGES = [
  { href: '/control', label: 'Control' },
  { href: '/sim', label: 'Autopilot sim' },
  { href: '/wildfire', label: 'Wildfire map' },
  { href: '/live', label: 'Live 3D' },
] as const

export type Page = (typeof PAGES)[number]['href']
export type Shortcut = { keys: string[]; label: string }

/** Keyboard events that belong to a text field (or carry a modifier) are never shortcuts. */
export function isShortcutEvent(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  const t = e.target
  if (!(t instanceof HTMLElement)) return true
  if (t.closest('dialog')) return false
  return !(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

/** Ember's mark: the flame cut by its firebreak (assets/ember-mark.svg). */
export function EmberMark({ size = 20 }: { size?: number }) {
  const mask = `ember-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg width={size * 0.72} height={size} viewBox="112 56 288 400" aria-hidden>
      <mask id={mask}>
        <rect x="0" y="0" width="512" height="512" fill="#fff" />
        <rect x="0" y="356" width="512" height="26" fill="#000" />
      </mask>
      <path
        mask={`url(#${mask})`}
        fill="var(--ember)"
        d="M256 64C334 146 384 210 384 314C384 394 326 448 256 448C186 448 128 394 128 314C128 252 156 210 194 172C198 212 212 234 236 244C222 188 228 118 256 64Z"
      />
    </svg>
  )
}

/**
 * Every rover page's frame: the top bar (mark, pages, live status, panel/shortcut/theme buttons), the
 * stage that fills the screen, and the rail of modules with its edge dock.
 */
export function Shell({
  page,
  status,
  actions,
  banner,
  stage,
  modules,
  railFooter,
  shortcuts,
}: {
  page: Page
  /** Live status in the top bar (connection, mode, clock). */
  status?: ReactNode
  /** Page-level controls at the end of the top bar (e.g. a stop button). */
  actions?: ReactNode
  /** A full-width strip above the stage (e.g. simulated mode). */
  banner?: ReactNode
  stage: ReactNode
  modules: ReactNode
  railFooter?: ReactNode
  shortcuts: Shortcut[]
}) {
  return (
    <LayoutProvider storageKey={`ember.layout${page}`}>
      <ShellFrame page={page} status={status} actions={actions} banner={banner} stage={stage} modules={modules} railFooter={railFooter} shortcuts={shortcuts} />
    </LayoutProvider>
  )
}

function ShellFrame({ page, status, actions, banner, stage, modules, railFooter, shortcuts }: Parameters<typeof Shell>[0]) {
  const layout = useLayout()
  const theme = useTheme()
  const dialog = useRef<HTMLDialogElement>(null)
  const all: Shortcut[] = [...shortcuts, { keys: ['\\'], label: 'Show or hide the panels' }, { keys: ['?'], label: 'This list' }]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcutEvent(e)) return
      if (e.key === '?') {
        e.preventDefault()
        if (dialog.current?.open) dialog.current.close()
        else dialog.current?.showModal()
      } else if (e.key === '\\' && layout.wide) {
        e.preventDefault()
        layout.setRail(!layout.rail)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layout])

  const themeIcon = theme.choice === 'dark' ? <Icons.moon /> : theme.choice === 'light' ? <Icons.sun /> : <Icons.monitor />

  return (
    <div className="ember flex min-h-full flex-col lg:h-full">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 pt-2.5 pb-2 lg:flex-nowrap lg:px-4">
        <Link href="/control" className="flex items-center gap-2.5 rounded-md py-1 pr-1" aria-label="Ember, rover control">
          <EmberMark />
          <span className="hidden text-[13px] font-medium tracking-[0.28em] text-ink sm:inline" style={{ fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" }}>
            EMBER
          </span>
        </Link>

        <nav aria-label="Pages" className="order-last -mx-1 flex w-full gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] lg:order-none lg:mx-0 lg:w-auto lg:px-0">
          {PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              aria-current={page === p.href ? 'page' : undefined}
              className={`relative rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
                page === p.href ? 'text-ink' : 'text-ink-2 hover:bg-panel hover:text-ink'
              }`}
            >
              {p.label}
              {page === p.href && <span aria-hidden className="absolute inset-x-2.5 -bottom-[3px] h-[2px] rounded-full bg-ember" />}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {status}
          {actions}
          <div className="flex items-center gap-0.5 border-l border-line pl-2">
            {layout.wide && (
              <IconButton label={layout.rail ? 'Hide panels (\\)' : 'Show panels (\\)'} pressed={layout.rail} onClick={() => layout.setRail(!layout.rail)}>
                <Icons.panel />
              </IconButton>
            )}
            <IconButton label="Keyboard shortcuts (?)" onClick={() => dialog.current?.showModal()} className="hidden sm:grid">
              <Icons.keyboard />
            </IconButton>
            <IconButton label={`Theme: ${theme.choice}. Switch theme`} onClick={theme.cycle}>
              {themeIcon}
            </IconButton>
          </div>
        </div>
      </header>

      {banner}

      <main className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2 lg:flex-row lg:px-2.5 lg:pb-2.5">
        <div className="relative h-[58vh] min-h-[320px] shrink-0 overflow-hidden rounded-[10px] bg-stage lg:h-auto lg:min-w-0 lg:flex-1 lg:shrink">
          {stage}
        </div>
        <Rail footer={railFooter}>{modules}</Rail>
        <Dock />
      </main>

      <ShortcutsDialog ref={dialog} shortcuts={all} onReset={layout.reset} />
    </div>
  )
}

function ShortcutsDialog({ ref, shortcuts, onReset }: { ref: React.Ref<HTMLDialogElement>; shortcuts: Shortcut[]; onReset: () => void }) {
  const [resetDone, setResetDone] = useState(false)
  return (
    <dialog
      ref={ref}
      aria-labelledby="shortcuts-title"
      onClose={() => setResetDone(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close()
      }}
      className="ember m-auto w-[min(420px,calc(100%-2rem))] rounded-xl border border-line bg-panel p-0 text-ink shadow-float"
    >
      <div className="flex items-center justify-between border-b border-line py-2 pr-2 pl-4">
        <h2 id="shortcuts-title" className="text-[11px] font-semibold tracking-[0.14em] uppercase">
          Keyboard
        </h2>
        <form method="dialog">
          <IconButton label="Close" type="submit">
            <Icons.close />
          </IconButton>
        </form>
      </div>
      <dl className="px-4 py-2">
        {shortcuts.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-4 py-1.5 [&+&]:border-t [&+&]:border-line">
            <dt className="text-[13px] text-ink-2">{s.label}</dt>
            <dd className="flex shrink-0 gap-1">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <p className="text-xs text-ink-3">{resetDone ? 'Panels are back where they started.' : 'Panel sizes and docking are remembered.'}</p>
        <button
          type="button"
          onClick={() => {
            onReset()
            setResetDone(true)
          }}
          className="text-xs font-medium whitespace-nowrap text-ember-ink underline-offset-4 hover:underline"
        >
          Reset layout
        </button>
      </div>
    </dialog>
  )
}
