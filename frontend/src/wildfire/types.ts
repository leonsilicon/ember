import type { Polygon } from 'geojson'

export type CategoryKey =
  | 'extreme' | 'high' | 'moderate' | 'low' | 'pine_eval' | 'water' | 'not_rated' | 'unknown' | 'nodata'

export interface Category {
  label: string
  rank: number
  hazard: boolean
  color: string
  legend: string
}

export interface Categories {
  screening_distance_m: number
  source: { name: string; date: string; resolution_m: number; url: string; codes_reference: string }
  categories: Record<CategoryKey, Category>
  codes: Record<string, { fuel: string; category: CategoryKey; note?: string }>
}

export interface Coverage {
  area_name: string
  bbox: [number, number, number, number]
  coverage: Polygon
  screening_distance_m: number
  source: Categories['source']
  buildings_source: string
  stats: { total: number; hazard_overlap: number; hazard_within_30m: number; needs_evaluation: number; incomplete: number }
  tiles: { buildings: string; hazard: string; leafoff?: string }
  leafoff?: {
    leaf_on?: { id: string; date: string; cloud_cover: number }
    leaf_off?: { id: string; date: string; cloud_cover: number }
    source?: string
    classes: { min_drop: number; drop_class: number }[]
    full_drop: number
  } | null
}

export interface BuildingProps {
  fid: number
  gers_id: string | null
  hazard_overlap: boolean
  hazard_within_30m: boolean
  highest_category_footprint: CategoryKey | null
  highest_category_30m: CategoryKey | null
  needs_evaluation: boolean
  has_not_rated: boolean
  coverage_complete: boolean
  nearest_hazard_m: number | null
  fuel_codes_footprint: string
  fuel_codes_30m: string
  footprint_source: string | null
  lon: number
  lat: number
  area_m2: number
  leafoff_30m: number | null
  scan_priority: number | null
}

export type Verdict = 'overlap' | 'within' | 'none'

export function verdictOf(b: BuildingProps): Verdict {
  if (b.hazard_overlap) return 'overlap'
  if (b.hazard_within_30m) return 'within'
  return 'none'
}

export const VERDICT_STYLE: Record<Verdict, { label: string; color: string; badge: string }> = {
  overlap: { label: 'High/Extreme hazard overlaps footprint', color: '#dc2626', badge: 'bg-red-600 text-white' },
  within: { label: 'High/Extreme hazard within 30 m', color: '#d97706', badge: 'bg-amber-500 text-zinc-950' },
  none: { label: 'No High/Extreme hazard detected within 30 m', color: '#64748b', badge: 'bg-slate-200 text-slate-800' },
}

export type ListFilter = 'all' | 'flagged' | 'priority' | 'eval' | 'incomplete'

export function parseCodes(s: string | undefined): number[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(Number) : []
  } catch {
    return []
  }
}

export function normalizeProps(p: Record<string, unknown>, id?: string | number): BuildingProps {
  const bool = (v: unknown) => v === true || v === 1 || v === 'true'
  return {
    ...(p as unknown as BuildingProps),
    fid: Number(p.fid ?? id),
    hazard_overlap: bool(p.hazard_overlap),
    hazard_within_30m: bool(p.hazard_within_30m),
    needs_evaluation: bool(p.needs_evaluation),
    has_not_rated: bool(p.has_not_rated),
    coverage_complete: bool(p.coverage_complete),
    nearest_hazard_m: p.nearest_hazard_m == null ? null : Number(p.nearest_hazard_m),
    highest_category_footprint: (p.highest_category_footprint as CategoryKey) ?? null,
    highest_category_30m: (p.highest_category_30m as CategoryKey) ?? null,
    leafoff_30m: p.leafoff_30m == null ? null : Number(p.leafoff_30m),
    scan_priority: p.scan_priority == null ? null : Number(p.scan_priority),
  }
}

export function applyFilter(items: BuildingProps[], f: ListFilter, dryness = 0.5) {
  switch (f) {
    case 'flagged':
      return items.filter((b) => b.hazard_overlap || b.hazard_within_30m)
    case 'priority':
      return items.filter((b) => (liveScore(b, dryness) ?? 0) >= SCAN_SOON)
    case 'eval':
      return items.filter((b) => b.needs_evaluation)
    case 'incomplete':
      return items.filter((b) => !b.coverage_complete)
    default:
      return items
  }
}

/** Sub-metre gaps are shown as "<1 m" so a within-30 m building never reads like an overlap. */
export function fmtM(m: number): string {
  if (m <= 0) return '0 m'
  if (m < 1) return '<1 m'
  return `${Math.round(m)} m`
}

/** Scan priority shown in the UI: the static hazard x litter score scaled by today's fine-fuel dryness (0.4-1). */
export function liveScore(b: BuildingProps, dryness: number): number | null {
  if (b.scan_priority == null) return null
  return Math.round(b.scan_priority * (0.4 + 0.6 * dryness))
}

export const SCAN_SOON = 40

export function scoreTone(score: number): { label: string; color: string } {
  if (score >= 70) return { label: 'Scan now', color: '#f43f5e' }
  if (score >= SCAN_SOON) return { label: 'Scan soon', color: '#fb923c' }
  if (score >= 20) return { label: 'Monitor', color: '#facc15' }
  return { label: 'Low', color: '#64748b' }
}
