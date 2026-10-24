import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl'
import type { Categories, CategoryKey } from './types'
import { VERDICT_STYLE } from './types'

export const BASEMAP = 'https://tiles.openfreemap.org/styles/positron'
export const HAZARD_SOURCE = 'wf-hazard'
export const BUILDINGS_SOURCE = 'wf-buildings'
export const SELECTED_SOURCE = 'wf-selected'
export const L = {
  hazardFill: 'wf-hazard-fill',
  buildingsFill: 'wf-buildings-fill',
  buildingsLine: 'wf-buildings-line',
  selectedRing: 'wf-selected-ring',
  selectedFill: 'wf-selected-fill',
  selectedOutline: 'wf-selected-outline',
} as const

const MUTED: CategoryKey[] = ['not_rated', 'unknown', 'nodata']

export function hazardColor(cats: Categories): ExpressionSpecification {
  const pairs = Object.entries(cats.categories).flatMap(([k, v]) => [k, v.color])
  return ['match', ['get', 'cat'], ...pairs, '#6b7280'] as unknown as ExpressionSpecification
}

/** Hazard classes at full strength; lower classes fade so High/Extreme stay legible. */
export function hazardOpacity(opacity: number): ExpressionSpecification {
  return ['*', opacity, ['match', ['get', 'cat'], MUTED, 0.25, 'low', 0.35, 'moderate', 0.5, 'pine_eval', 0.7, 1]] as ExpressionSpecification
}

export const buildingColor: ExpressionSpecification = [
  'case',
  ['==', ['get', 'hazard_overlap'], true], VERDICT_STYLE.overlap.color,
  ['==', ['get', 'hazard_within_30m'], true], VERDICT_STYLE.within.color,
  VERDICT_STYLE.none.color,
]

export const buildingOutline: ExpressionSpecification = [
  'case',
  ['==', ['get', 'coverage_complete'], false], '#0f172a',
  ['==', ['get', 'needs_evaluation'], true], '#7e22ce',
  '#ffffff',
]

/** Pixel width that equals `meters` on the ground at `lat`, for every zoom. */
export function metersToPx(meters: number, lat: number, scale = 1): ExpressionSpecification {
  const mppZ0 = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 512
  const px = (z: number) => (scale * meters) / (mppZ0 / 2 ** z)
  return ['interpolate', ['exponential', 2], ['zoom'], 0, px(0), 24, px(24)]
}

export function hazardLayer(cats: Categories, opacity: number): LayerSpecification {
  return {
    id: L.hazardFill,
    type: 'fill',
    source: HAZARD_SOURCE,
    'source-layer': 'hazard',
    paint: { 'fill-color': hazardColor(cats), 'fill-opacity': hazardOpacity(opacity), 'fill-antialias': false },
  }
}

export function buildingLayers(): LayerSpecification[] {
  return [
    {
      id: L.buildingsFill,
      type: 'fill',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      paint: { 'fill-color': buildingColor, 'fill-opacity': 0.85 },
    },
    {
      id: L.buildingsLine,
      type: 'line',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      minzoom: 14,
      paint: {
        'line-color': buildingOutline,
        'line-width': ['case', ['==', ['get', 'coverage_complete'], false], 1.5, ['==', ['get', 'needs_evaluation'], true], 1.5, 0.6],
        'line-dasharray': ['case', ['==', ['get', 'coverage_complete'], false], ['literal', [2, 1.5]], ['literal', [1, 0]]],
      },
    },
  ]
}

export function selectedLayers(lat: number, screeningM: number): LayerSpecification[] {
  return [
    {
      // centred on the footprint edge, so the outer half is exactly the 30 m band; the inner
      // half is hidden under the selected fill. Avoids line-offset, which tears at large widths.
      id: L.selectedRing,
      type: 'line',
      source: SELECTED_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.22, 'line-width': metersToPx(screeningM, lat, 2) },
    },
    {
      id: L.selectedFill,
      type: 'fill',
      source: SELECTED_SOURCE,
      paint: { 'fill-color': '#e0f2fe', 'fill-opacity': 1 },
    },
    {
      id: L.selectedOutline,
      type: 'line',
      source: SELECTED_SOURCE,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#0f172a', 'line-width': 3 },
    },
  ]
}

export function firstSymbolLayer(layers: LayerSpecification[]): string | undefined {
  return layers.find((l) => l.type === 'symbol')?.id
}
