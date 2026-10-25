import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icons } from './kit'

/**
 * The rail of modules beside the stage, and the state of each module: open, collapsed to its header, or
 * docked (taken out of the rail onto the edge tab strip). The whole rail can be hidden too, and its width
 * is dragged from its edge. All of it is remembered per page in localStorage.
 */

export type ModuleState = 'open' | 'collapsed' | 'docked'
type Saved = { rail: boolean; width: number; modules: Record<string, ModuleState> }

export const RAIL_WIDTH = { min: 300, max: 560, default: 360 }
const DEFAULTS: Saved = { rail: true, width: RAIL_WIDTH.default, modules: {} }

function load(key: string): Saved {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return DEFAULTS
    const saved = JSON.parse(raw) as Partial<Saved>
    return {
      rail: saved.rail ?? true,
      width: clampWidth(saved.width ?? RAIL_WIDTH.default),
      modules: saved.modules && typeof saved.modules === 'object' ? saved.modules : {},
    }
  } catch {
    return DEFAULTS
  }
}

const clampWidth = (w: number) => Math.round(Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, w)))

type Registered = { id: string; title: string; defaultState: ModuleState }

type LayoutContext = {
  rail: boolean
  setRail: (open: boolean) => void
  width: number
  setWidth: (w: number) => void
  stateOf: (id: string) => ModuleState
  setState: (id: string, state: ModuleState) => void
  register: (m: Registered) => () => void
  modules: Registered[]
  reset: () => void
  /** Narrow screens stack modules under the stage: no docking or rail hiding there. */
  wide: boolean
}

const Ctx = createContext<LayoutContext | null>(null)

export function useLayout() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useLayout outside <LayoutProvider>')
  return ctx
}

function useWide() {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setWide(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return wide
}

export function LayoutProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [saved, setSaved] = useState<Saved>(() => load(storageKey))
  const [modules, setModules] = useState<Registered[]>([])
  const wide = useWide()

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved))
    } catch {
      // Private mode: the layout lasts for this visit only.
    }
  }, [saved, storageKey])

  const register = useCallback((m: Registered) => {
    setModules((list) => [...list.filter((x) => x.id !== m.id), m])
    return () => setModules((list) => list.filter((x) => x.id !== m.id))
  }, [])

  const value = useMemo<LayoutContext>(() => {
    const stateOf = (id: string): ModuleState => {
      const s = saved.modules[id] ?? modules.find((m) => m.id === id)?.defaultState ?? 'open'
      return !wide && s === 'docked' ? 'collapsed' : s
    }
    return {
      rail: wide ? saved.rail : true,
      setRail: (rail) => setSaved((s) => ({ ...s, rail })),
      width: saved.width,
      setWidth: (w) => setSaved((s) => ({ ...s, width: clampWidth(w) })),
      stateOf,
      setState: (id, state) =>
        setSaved((s) => ({
          ...s,
          // Restoring a module while the rail is hidden brings the rail back with it.
          rail: state !== 'docked' ? true : s.rail,
          modules: { ...s.modules, [id]: state },
        })),
      register,
      modules,
      reset: () => setSaved(DEFAULTS),
      wide,
    }
  }, [saved, modules, register, wide])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** A rail module: a titled panel that collapses to its header or docks to the edge tab strip. */
export function Module({
  id,
  title,
  meta,
  actions,
  defaultState = 'open',
  flush,
  children,
}: {
  id: string
  title: string
  /** A short live readout in the header, visible even while collapsed. */
  meta?: ReactNode
  actions?: ReactNode
  defaultState?: ModuleState
  /** No body padding (for a map or a camera picture edge to edge). */
  flush?: boolean
  children: ReactNode
}) {
  const layout = useLayout()
  const { register } = layout
  useEffect(() => register({ id, title, defaultState }), [register, id, title, defaultState])
  const state = layout.stateOf(id)
  const collapsed = state === 'collapsed'
  const bodyId = `module-${id}`

  return (
    <section
      aria-labelledby={`${bodyId}-title`}
      // Docked modules stay mounted (a camera stream or a map keeps running), just out of the rail.
      hidden={state === 'docked'}
      className="shrink-0 overflow-hidden rounded-[10px] border border-line bg-panel"
    >
      <header className="flex h-10 items-center gap-1 pr-1.5 pl-3.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => layout.setState(id, collapsed ? 'open' : 'collapsed')}
          className="group -ml-1 flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md pl-1 text-left"
        >
          <span id={`${bodyId}-title`} className="truncate text-[11px] font-semibold tracking-[0.14em] text-ink uppercase">
            {title}
          </span>
          <span className={`text-ink-3 transition-transform duration-200 group-hover:text-ink ${collapsed ? '-rotate-90' : ''}`}>
            <Icons.chevron />
          </span>
          {meta != null && <span className="num ml-auto truncate pl-2 text-xs text-ink-2">{meta}</span>}
        </button>
        {actions}
        {layout.wide && (
          <button
            type="button"
            aria-label={`Dock ${title} to the side`}
            title="Dock to the side"
            onClick={() => layout.setState(id, 'docked')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-well hover:text-ink"
          >
            <Icons.dock />
          </button>
        )}
      </header>
      <div className="module-body" data-collapsed={collapsed} id={bodyId}>
        <div {...(collapsed ? { inert: true } : {})}>
          <div className={flush ? 'border-t border-line' : 'border-t border-line px-3.5 pt-3 pb-3.5'}>{children}</div>
        </div>
      </div>
    </section>
  )
}

/** The rail: the modules in a scrolling column, with a drag handle on its stage edge. */
export function Rail({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const layout = useLayout()
  const drag = useRef<{ x: number; width: number } | null>(null)

  return (
    <aside
      aria-label="Panels"
      hidden={!layout.rail}
      className="relative flex min-h-0 flex-col lg:h-full"
      style={layout.wide ? { width: layout.width } : undefined}
    >
      {layout.wide && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          aria-valuemin={RAIL_WIDTH.min}
          aria-valuemax={RAIL_WIDTH.max}
          aria-valuenow={layout.width}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') layout.setWidth(layout.width + 16)
            else if (e.key === 'ArrowRight') layout.setWidth(layout.width - 16)
            else return
            e.preventDefault()
          }}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, width: layout.width }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (drag.current) layout.setWidth(drag.current.width + drag.current.x - e.clientX)
          }}
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={() => layout.setWidth(RAIL_WIDTH.default)}
          className="group absolute top-0 bottom-0 -left-[7px] z-10 w-[8px] cursor-col-resize rounded-full outline-none"
        >
          <span className="absolute inset-y-6 left-[3px] w-[2px] rounded-full bg-transparent transition-colors group-hover:bg-line-strong group-focus-visible:bg-ember group-active:bg-ember" />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:overflow-y-auto lg:overscroll-contain">
        {children}
        {footer}
      </div>
    </aside>
  )
}

/** The edge tab strip: docked modules (or every module, while the rail is hidden) as vertical tabs. */
export function Dock() {
  const layout = useLayout()
  if (!layout.wide) return null
  const tabs = layout.modules.filter((m) => !layout.rail || layout.stateOf(m.id) === 'docked')
  if (tabs.length === 0) return null
  return (
    <nav aria-label="Docked panels" className="flex flex-col gap-2">
      {tabs.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => layout.setState(m.id, 'open')}
          title={`Open ${m.title}`}
          className="flex w-9 items-center justify-center rounded-[10px] border border-line bg-panel py-3.5 text-[11px] font-semibold tracking-[0.14em] text-ink-2 uppercase transition-colors [writing-mode:vertical-rl] hover:border-line-strong hover:text-ink"
        >
          {m.title}
        </button>
      ))}
    </nav>
  )
}
