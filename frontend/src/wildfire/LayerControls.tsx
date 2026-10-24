import { useState } from 'react'
import { LEAFOFF_COLORS } from './mapLayers'
import type { Categories, CategoryKey, Coverage } from './types'
import { VERDICT_STYLE } from './types'
import { MICRO, PANEL } from './ui'

export type Basemap = 'satellite' | 'dark'

interface Props {
  categories: Categories
  coverage: Coverage
  basemap: Basemap
  showHazard: boolean
  showBuildings: boolean
  showLeafoff: boolean
  showDryness: boolean
  opacity: number
  onBasemap: (v: Basemap) => void
  onHazard: (v: boolean) => void
  onBuildings: (v: boolean) => void
  onLeafoff: (v: boolean) => void
  onDryness: (v: boolean) => void
  onOpacity: (v: number) => void
}

const LEGEND_ORDER: CategoryKey[] = ['extreme', 'high', 'moderate', 'low', 'pine_eval', 'not_rated', 'unknown', 'nodata']

function Toggle({ label, hint, checked, onChange, accent = 'accent-cyan-400' }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; accent?: string }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span>
        {label}
        {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={accent} />
    </label>
  )
}

export function LayerControls(p: Props) {
  const [open, setOpen] = useState(true)
  const lo = p.coverage.leafoff
  return (
    <div className={`pointer-events-auto w-64 text-sm ${PANEL}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2" aria-expanded={open}>
        <span className={MICRO}>Layers</span>
        <span className="text-xs text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/10 px-3 py-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1 text-xs font-semibold">
            {(['satellite', 'dark'] as const).map((b) => (
              <button key={b} type="button" onClick={() => p.onBasemap(b)} className={`rounded-lg px-2 py-1 ${p.basemap === b ? 'bg-cyan-400 text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}>
                {b === 'satellite' ? 'Satellite' : 'Dark map'}
              </button>
            ))}
          </div>
          <Toggle label="Fuel hazard" hint="Ontario MNRF, 30 m" checked={p.showHazard} onChange={p.onHazard} accent="accent-red-500" />
          <label className="block">
            <span className="flex justify-between text-xs text-slate-500">
              <span>Hazard opacity</span>
              <span className="font-mono">{Math.round(p.opacity * 100)}%</span>
            </span>
            <input type="range" min={0} max={1} step={0.05} value={p.opacity} disabled={!p.showHazard} onChange={(e) => p.onOpacity(Number(e.target.value))} className="mt-1 w-full accent-red-500" />
          </label>
          <Toggle label="Buildings" hint="Overture footprints, screened" checked={p.showBuildings} onChange={p.onBuildings} />
          {lo && <Toggle label="Fresh leaf litter" hint={`Sentinel‑2 ${lo.leaf_on?.date ?? ''} → ${lo.leaf_off?.date ?? ''}`} checked={p.showLeafoff} onChange={p.onLeafoff} accent="accent-amber-400" />}
          <Toggle label="Fire weather (FWI)" hint="CWFIS daily grid, coarse" checked={p.showDryness} onChange={p.onDryness} accent="accent-emerald-400" />

          <div>
            <p className={`mb-1 ${MICRO}`}>Fuel hazard</p>
            <ul className="space-y-1">
              {LEGEND_ORDER.map((k) => {
                const c = p.categories.categories[k]
                return (
                  <li key={k} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 h-3 w-3 shrink-0 rounded-sm" style={{ background: c.color, opacity: c.hazard || c.rank > 0 ? 1 : 0.6 }} />
                    <span className="text-slate-300">
                      {c.label}
                      {c.legend && <span className="text-slate-500"> · {c.legend}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
          <div>
            <p className={`mb-1 ${MICRO}`}>Buildings</p>
            <ul className="space-y-1 text-xs text-slate-300">
              {(['overlap', 'within', 'none'] as const).map((v) => (
                <li key={v} className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: VERDICT_STYLE[v].color }} />
                  {v === 'overlap' ? 'Hazard overlaps footprint' : v === 'within' ? 'Hazard within 30 m' : 'None detected within 30 m'}
                </li>
              ))}
              <li className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-sm border-2 border-purple-400" />
                Pine nearby — needs evaluation
              </li>
              <li className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-sm border-2 border-dashed border-slate-200" />
                Incomplete data coverage
              </li>
            </ul>
          </div>
          {lo && p.showLeafoff && (
            <div>
              <p className={`mb-1 ${MICRO}`}>Fresh leaf litter · NDVI drop</p>
              <ul className="space-y-1 text-xs text-slate-300">
                {lo.classes.map((c, i) => (
                  <li key={c.drop_class} className="flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: LEAFOFF_COLORS[i] }} />
                    {i === lo.classes.length - 1 ? `≥ ${c.min_drop}` : `${c.min_drop} – ${lo.classes[i + 1].min_drop}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
