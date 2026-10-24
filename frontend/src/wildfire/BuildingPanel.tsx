import type { BuildingProps, Categories } from './types'
import { VERDICT_STYLE, parseCodes, verdictOf } from './types'

interface Props {
  b: BuildingProps
  categories: Categories
  onClose: () => void
}

function fmtM(m: number) {
  return m < 1 ? '0 m' : `${Math.round(m)} m`
}

export function BuildingPanel({ b, categories, onClose }: Props) {
  const verdict = verdictOf(b)
  const vs = VERDICT_STYLE[verdict]
  const cats = categories.categories
  const fp = parseCodes(b.fuel_codes_footprint)
  const ring = parseCodes(b.fuel_codes_30m)
  const fuel = (c: number) => categories.codes[String(c)]?.fuel ?? `code ${c}`
  const notRated = ring.filter((c) => {
    const k = categories.codes[String(c)]?.category
    return !k || k === 'not_rated' || k === 'unknown'
  })
  const screen = categories.screening_distance_m

  let explain: string
  if (verdict === 'overlap') {
    explain = `Part of this footprint sits on cells Ontario rates ${cats[b.highest_category_footprint ?? 'high'].label.toLowerCase()} hazard.`
  } else if (verdict === 'within') {
    explain = `The footprint itself is not on rated hazard, but ${cats[b.highest_category_30m ?? 'high'].label.toLowerCase()} hazard starts ${b.nearest_hazard_m != null ? fmtM(b.nearest_hazard_m) : 'less than ' + screen + ' m'} away — inside the ${screen} m screening distance.`
  } else {
    explain = `No cells rated High or Extreme touch the footprint or the ${screen} m band around it${b.nearest_hazard_m != null ? ` — nearest is ${fmtM(b.nearest_hazard_m)} away` : ''}.`
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div>
          <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Building #{b.fid}</p>
          <p className="text-xs text-slate-500">
            {b.lat.toFixed(5)}, {b.lon.toFixed(5)} · {Math.round(b.area_m2)} m²
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-3">
        <div className={`rounded-xl px-3 py-2.5 ${vs.badge}`}>
          <p className="text-sm font-bold leading-snug">{vs.label}</p>
        </div>
        <p className="text-sm leading-relaxed text-slate-700">{explain}</p>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <dt className="text-slate-500">Nearest High/Extreme</dt>
          <dd className="font-medium text-slate-900">{b.nearest_hazard_m == null ? 'None in area' : fmtM(b.nearest_hazard_m)}</dd>
          <dt className="text-slate-500">Highest rating on footprint</dt>
          <dd className="font-medium text-slate-900">{b.highest_category_footprint ? cats[b.highest_category_footprint].label : 'Not rated'}</dd>
          <dt className="text-slate-500">Highest rating within {screen} m</dt>
          <dd className="font-medium text-slate-900">{b.highest_category_30m ? cats[b.highest_category_30m].label : 'Not rated'}</dd>
        </dl>

        {b.needs_evaluation && (
          <Note tone="purple" title="Pine stand within 30 m — needs evaluation">
            Ontario does not rate red/white pine (C‑5) or plantations automatically; a site check is recommended.
          </Note>
        )}
        {!b.coverage_complete && (
          <Note tone="slate" title="Incomplete data coverage">
            Part of the footprint or its {screen} m band falls outside the hazard data or the pilot area. The result above only covers the part we could check.
          </Note>
        )}
        {notRated.length > 0 && (
          <Note tone="slate" title="Not rated by Ontario nearby">
            {notRated.map(fuel).join(' · ')}. These are shown as-is, not treated as safe.
          </Note>
        )}

        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">Fuel types found</summary>
          <p className="mt-1">
            <span className="text-slate-500">On footprint:</span> {fp.length ? fp.map(fuel).join(' · ') : '—'}
          </p>
          <p className="mt-1">
            <span className="text-slate-500">Within {screen} m:</span> {ring.length ? ring.map(fuel).join(' · ') : '—'}
          </p>
        </details>

        <p className="border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
          Hazard: {categories.source.name}, {categories.source.date}, {categories.source.resolution_m} m cells. {screen} m is this tool's screening
          distance, informed by FireSmart's Home Ignition Zone; it is not a FireSmart assessment. Footprint: Overture
          {b.footprint_source ? ` (${b.footprint_source})` : ''}.
        </p>
      </div>
    </div>
  )
}

function Note({ tone, title, children }: { tone: 'purple' | 'slate'; title: string; children: React.ReactNode }) {
  const cls = tone === 'purple' ? 'border-purple-200 bg-purple-50 text-purple-900' : 'border-slate-200 bg-slate-50 text-slate-800'
  return (
    <div className={`rounded-xl border px-3 py-2 text-xs ${cls}`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5 leading-relaxed opacity-90">{children}</p>
    </div>
  )
}
