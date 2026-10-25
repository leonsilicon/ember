import Link from 'next/link'

const PAGES = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/control', label: 'Control' },
  { href: '/sim', label: 'Autopilot sim' },
  { href: '/wildfire', label: 'Wildfire map' },
] as const

export type Page = (typeof PAGES)[number]['href']

/**
 * The header's page switcher, shared by the control panel and the autopilot simulator. The dashboard
 * is in the other root layout (`app/(splat)`), so going there is a full page load.
 */
export function AppNav({ current }: { current: Page }) {
  return (
    <nav className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 text-sm" aria-label="Pages">
      {PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={current === p.href ? 'page' : undefined}
          className={`rounded-md px-3 py-1 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-400 ${
            current === p.href ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'
          }`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  )
}
