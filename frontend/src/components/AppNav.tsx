const PAGES = [
  { hash: '#/', label: 'Control' },
  { hash: '#/sim', label: 'Autopilot sim' },
] as const

export type Page = (typeof PAGES)[number]['hash']

/** The header's page switcher, shared by the control panel and the autopilot simulator. */
export function AppNav({ current }: { current: Page }) {
  return (
    <nav className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 text-sm" aria-label="Pages">
      {PAGES.map((p) => (
        <a
          key={p.hash}
          href={p.hash}
          aria-current={current === p.hash ? 'page' : undefined}
          className={`rounded-md px-3 py-1 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-400 ${
            current === p.hash ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'
          }`}
        >
          {p.label}
        </a>
      ))}
    </nav>
  )
}
