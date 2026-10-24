import type { BuildingProps, ListFilter } from './types'
import { VERDICT_STYLE, applyFilter, verdictOf, fmtM, liveScore, scoreTone } from './types'
import { CHIP_OFF, CHIP_ON, MICRO } from './ui'

interface Props {
  items: BuildingProps[]
  filter: ListFilter
  dryness: number
  onFilter: (f: ListFilter) => void
  onPick: (b: BuildingProps) => void
  zoomedOut: boolean
}

const RANK = { overlap: 0, within: 1, none: 2 }

export function VisibleList({ items, filter, dryness, onFilter, onPick, zoomedOut }: Props) {
  const flagged = items.filter((b) => b.hazard_overlap || b.hazard_within_30m).length
  const byPriority = filter === 'priority'
  const shown = applyFilter(items, filter, dryness).sort((a, b) =>
    byPriority
      ? (liveScore(b, dryness) ?? -1) - (liveScore(a, dryness) ?? -1)
      : RANK[verdictOf(a)] - RANK[verdictOf(b)] || (a.nearest_hazard_m ?? 1e9) - (b.nearest_hazard_m ?? 1e9),
  )
  const tabs: [ListFilter, string][] = [
    ['all', `All ${items.length}`],
    ['flagged', `Flagged ${flagged}`],
    ['priority', 'Scan priority'],
    ['eval', 'Pine eval'],
    ['incomplete', 'Incomplete'],
  ]
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <p className={MICRO}>Visible buildings</p>
        <p className="mt-0.5 text-sm text-slate-300">
          {zoomedOut ? 'Zoom in to list buildings.' : `${flagged} of ${items.length} in view have High/Extreme hazard within 30 m.`}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" onClick={() => onFilter(k)} className={`rounded-full px-2.5 py-1 text-xs font-medium ${filter === k ? CHIP_ON : CHIP_OFF}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-2 flex-1 divide-y divide-white/5 overflow-y-auto px-2 pb-2">
        {!zoomedOut && shown.length === 0 && <li className="px-2 py-6 text-center text-sm text-slate-500">Nothing matches this filter in view.</li>}
        {shown.slice(0, 200).map((b) => {
          const v = verdictOf(b)
          const score = liveScore(b, dryness)
          return (
            <li key={b.fid}>
              <button type="button" onClick={() => onPick(b)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: VERDICT_STYLE[v].color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">
                    <span className="font-mono text-slate-400">#{b.fid}</span> · {v === 'overlap' ? 'Overlaps hazard' : v === 'within' ? 'Hazard within 30 m' : 'None within 30 m'}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {b.nearest_hazard_m != null ? `${fmtM(b.nearest_hazard_m)} to nearest High/Extreme` : 'No High/Extreme in area'}
                    {b.needs_evaluation ? ' · pine eval' : ''}
                    {!b.coverage_complete ? ' · incomplete data' : ''}
                  </span>
                </span>
                {score != null && (
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-sm tabular-nums" style={{ color: scoreTone(score).color }}>{score}</span>
                    <span className="block text-[10px] text-slate-500">{scoreTone(score).label}</span>
                  </span>
                )}
              </button>
            </li>
          )
        })}
        {shown.length > 200 && <li className="px-2 py-2 text-center text-xs text-slate-500">Showing first 200 — zoom in for the rest.</li>}
      </ul>
    </div>
  )
}
