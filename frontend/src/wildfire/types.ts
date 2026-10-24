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
  tiles: { buildings: string; hazard: string }
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

export type ListFilter = 'all' | 'flagged' | 'eval' | 'incomplete'

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
  }
}

export function applyFilter(items: BuildingProps[], f: ListFilter) {
  switch (f) {
    case 'flagged':
      return items.filter((b) => b.hazard_overlap || b.hazard_within_30m)
    case 'eval':
      return items.filter((b) => b.needs_evaluation)
    case 'incomplete':
      return items.filter((b) => !b.coverage_complete)
    default:
      return items
  }
}
