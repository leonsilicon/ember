import { useState } from 'react'
import type { Categories, CategoryKey } from './types'
import { VERDICT_STYLE } from './types'

interface Props {
  categories: Categories
  showHazard: boolean
  showBuildings: boolean
  opacity: number
  onHazard: (v: boolean) => void
  onBuildings: (v: boolean) => void
  onOpacity: (v: number) => void
}

const LEGEND_ORDER: CategoryKey[] = ['extreme', 'high', 'moderate', 'low', 'pine_eval', 'not_rated', 'unknown', 'nodata']

export function LayerControls({ categories, showHazard, showBuildings, opacity, onHazard, onBuildings, onOpacity }: Props) {
  const [open, setOpen] = useState(true)
  return (
    <div className="pointer-events-auto w-60 rounded-2xl border border-slate-200 bg-white/95 text-sm shadow-lg shadow-slate-900/10 backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 font-semibold text-slate-800"
        aria-expanded={open}
      >
        Layers
        <span className="text-xs text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3">
          <label className="flex items-center justify-between gap-2">
            <span>Hazard zones</span>
            <input type="checkbox" checked={showHazard} onChange={(e) => onHazard(e.target.checked)} className="accent-red-600" />
          </label>
          <label className="block">
            <span className="flex justify-between text-xs text-slate-500">
              <span>Hazard opacity</span>
              <span>{Math.round(opacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              disabled={!showHazard}
              onChange={(e) => onOpacity(Number(e.target.value))}
              className="mt-1 w-full accent-red-600"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Buildings</span>
            <input type="checkbox" checked={showBuildings} onChange={(e) => onBuildings(e.target.checked)} className="accent-slate-800" />
          </label>

          <div>
            <p className="mb-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Hazard zones</p>
            <ul className="space-y-1">
              {LEGEND_ORDER.map((k) => {
                const c = categories.categories[k]
                return (
                  <li key={k} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 h-3 w-3 shrink-0 rounded-sm" style={{ background: c.color, opacity: c.hazard || c.rank > 0 ? 1 : 0.6 }} />
                    <span className="text-slate-700">
                      {c.label}
                      {c.legend && <span className="text-slate-400"> · {c.legend}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Buildings</p>
            <ul className="space-y-1 text-xs text-slate-700">
              {(['overlap', 'within', 'none'] as const).map((v) => (
                <li key={v} className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: VERDICT_STYLE[v].color }} />
                  {v === 'overlap' ? 'Hazard overlaps footprint' : v === 'within' ? 'Hazard within 30 m' : 'None detected within 30 m'}
                </li>
              ))}
              <li className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-sm border-2 border-purple-700 bg-white" />
                Pine nearby — needs evaluation
              </li>
              <li className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-sm border-2 border-dashed border-slate-900 bg-white" />
                Incomplete data coverage
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
