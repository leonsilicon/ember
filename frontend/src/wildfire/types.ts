import type { FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson'

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
  tiles: { buildings: string }
  zones?: { file: string; count: number; weights: { fuel: number; leafoff: number }; min_score: number; min_ha: number; formula: string }
  density?: { file: string; count: number; search_m: number; min_homes_per_ha: number; min_ha: number }
  roads?: { file: string; count: number; classes: string[]; source: string }
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

/** One high fire-risk zone from zones.geojson (pipeline `zones.py`). */
export interface ZoneProps {
  zid: number
  area_ha: number
  /** mean cell score 0-1: 0.6 x fuel weight + 0.4 x leaf-off */
  score: number
  /** share of the zone's cells per fuel category */
  fuel_mix: Partial<Record<'extreme' | 'high' | 'pine_eval' | 'moderate' | 'low' | 'other', number>>
  top_fuel: string | null
  /** share of cells with a Sentinel-2 NDVI drop >= 0.25 */
  leafoff_share: number
  homes_in: number
  homes_30m: number
  homes_500m: number
  /** metres to the nearest lake or river >= 1 ha; null if none in the pilot */
  water_m: number | null
  /** label point, inside the zone */
  lon: number
  lat: number
}

export type Zones = FeatureCollection<Polygon | MultiPolygon, ZoneProps>

/** One high-density home area from density.geojson (pipeline `density.py`). */
export interface DensityProps {
  did: number
  area_ha: number
  homes: number
  homes_per_ha: number
  lon: number
  lat: number
}

export type DensityAreas = FeatureCollection<Polygon | MultiPolygon, DensityProps>

export interface RoadProps {
  rid: number
  name: string | null
  class: string
}

export type Roads = FeatureCollection<LineString, RoadProps>

export interface Area {
  id: string
  name: string
  /** URL prefix of this area's static files, e.g. /wildfire/newmarket/ */
  base: string
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
