import Link from 'next/link';

import { currentLogin } from '#web/auth.ts';

import { logout } from './(splat)/actions';
import styles from './tool-shell.module.css';

/** The four tools behind the sign-in, in tab order. */
export const TOOLS = [
  { href: '/control', label: 'Rover control', title: 'Drive the rover and arm from the laptop, with the splat viewer and the phone camera.' },
  { href: '/live', label: 'Live 3D', title: 'Follow the phone’s recording as the Mac rebuilds it in 3D, and open the captures it trains into splats.' },
  { href: '/sim', label: 'Autopilot sim', title: 'The rover’s own brain clearing a virtual yard.' },
  { href: '/wildfire', label: 'Wildfire map', title: 'Buildings and their wildfire hazard, on a map.' },
] as const;

export type Tool = (typeof TOOLS)[number]['href'];

/**
 * Every signed-in page: the top bar that switches between the four tools, with who's signed in and
 * Sign out, and the page under it filling the rest of the window. `current` is the tab to light; a
 * page that isn't one of the tools (a capture's splat viewer) leaves it out. The tools are split
 * across two root layouts (`(splat)` and `(rover)`), so a tab across that line is a full page load.
 */
export async function ToolShell({ current, children }: { current?: Tool; children: React.ReactNode }) {
  const who = await currentLogin();
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <span className={styles.brand}>soon2026</span>
        <nav className={styles.tabs} aria-label="Tools">
          {TOOLS.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              title={tool.title}
              aria-current={current === tool.href ? 'page' : undefined}
              className={styles.tab}
            >
              {tool.label}
            </Link>
          ))}
        </nav>
        <div className={styles.account}>
          {who && <span className={styles.who}>{who}</span>}
          <form action={logout}>
            <button type="submit" className={styles.signOut}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
