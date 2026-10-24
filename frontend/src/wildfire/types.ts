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
  stats: { total: number; hazard_overlap: number; hazard_within_30m: number; needs_evaluation: number; incomplete: number; exposure_60?: number }
  tiles: { buildings: string; hazard: string; leafoff?: string }
  files?: { buildings: string }
  grid?: {
    file: string
    width: number
    height: number
    cell_m: number
    crs: string
    origin: [number, number]
    res: number
    codes: { index: number; code: number; fuel: string; cat: CategoryKey }[]
  }
  risk?: { weights: { fuel: number; leafoff: number; neighbours: number }; neighbour_cap: number; formula: string }
  leafoff?: {
    leaf_on?: { id: string; date: string; cloud_cover: number }
    leaf_off?: { id: string; date: string; cloud_cover: number }
    source?: string
    classes: { min_drop: number; drop_class: number }[]
    full_drop: number
  } | null
}

/** Compact per-building rows from buildings.json (same order as `fields`). */
export interface BuildingRow {
  fid: number
  lon: number
  lat: number
  exposure: number
  f_fuel: number
  l_leafoff: number
  n_neighbours: number
  area_m2: number
}

export interface BuildingProps extends BuildingRow {
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
  leafoff_30m: number | null
}

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
  const num = (v: unknown, d = 0) => (v == null ? d : Number(v))
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
    exposure: num(p.exposure),
    f_fuel: num(p.f_fuel),
    l_leafoff: num(p.l_leafoff, 0.5),
    n_neighbours: num(p.n_neighbours),
  }
}

/** Sub-metre gaps are shown as "<1 m" so a within-30 m building never reads like an overlap. */
export function fmtM(m: number): string {
  if (m <= 0) return '0 m'
  if (m < 1) return '<1 m'
  return `${Math.round(m)} m`
}

// ---- Ignition Risk: one number per home ------------------------------------------------------
// risk = 100 × exposure × (0.4 + 0.6 × dryness)
// exposure = 0.55 F (fuel in the 30 m zone) + 0.25 L (fresh leaf litter) + 0.20 N (neighbouring structures), from the pipeline
// dryness  = today's CWFIS FFMC mapped 70..95 → 0..1, fetched live in the browser

export const CRITICAL = 70
export const ELEVATED = 40

export type Band = 'critical' | 'elevated' | 'low'

export function riskOf(exposure: number, dryness: number): number {
  return Math.round(100 * exposure * (0.4 + 0.6 * dryness))
}

export function bandOf(risk: number): Band {
  if (risk >= CRITICAL) return 'critical'
  if (risk >= ELEVATED) return 'elevated'
  return 'low'
}

export const BAND: Record<Band, { label: string; color: string; intent: 'danger' | 'warning' | 'none'; blurb: string }> = {
  critical: { label: 'Critical', color: '#ff7373', intent: 'danger', blurb: 'Likely to ignite if fire reaches this lot' },
  elevated: { label: 'Elevated', color: '#ffb366', intent: 'warning', blurb: 'Ignites if the 30 m zone is not cleared' },
  low: { label: 'Low', color: '#8abbff', intent: 'none', blurb: 'Little fuel within 30 m' },
}

/** Multiplier the live dryness applies to every static exposure today. */
export const drynessMultiplier = (dryness: number) => 0.4 + 0.6 * dryness
