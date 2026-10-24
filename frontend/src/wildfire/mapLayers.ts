import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl'
import type { Categories, CategoryKey } from './types'
import { VERDICT_STYLE } from './types'
import { CWFIS_WMS, ESRI_IMAGERY } from './live'

export const BASEMAP = 'https://tiles.openfreemap.org/styles/dark'
export const HAZARD_SOURCE = 'wf-hazard'
export const BUILDINGS_SOURCE = 'wf-buildings'
export const SELECTED_SOURCE = 'wf-selected'
export const SATELLITE_SOURCE = 'wf-satellite'
export const DRYNESS_SOURCE = 'wf-dryness'
export const LEAFOFF_SOURCE = 'wf-leafoff'
export const L = {
  satellite: 'wf-satellite',
  dryness: 'wf-dryness',
  leafoff: 'wf-leafoff-fill',
  hazardFill: 'wf-hazard-fill',
  buildingsFill: 'wf-buildings-fill',
  buildingsLine: 'wf-buildings-line',
  selectedRing: 'wf-selected-ring',
  selectedOutline: 'wf-selected-outline',
} as const

const MUTED: CategoryKey[] = ['not_rated', 'unknown', 'nodata']

export function hazardColor(cats: Categories): ExpressionSpecification {
  const pairs = Object.entries(cats.categories).flatMap(([k, v]) => [k, v.color])
  return ['match', ['get', 'cat'], ...pairs, '#6b7280'] as unknown as ExpressionSpecification
}

/** Hazard classes at full strength; lower classes fade so High/Extreme stay legible. Over imagery the
 * not-rated/unknown cells go fully transparent — a grey slab over satellite hides more than it tells. */
export function hazardOpacity(opacity: number, satellite = false): ExpressionSpecification {
  return ['*', opacity, ['match', ['get', 'cat'], MUTED, satellite ? 0 : 0.25, 'low', satellite ? 0.25 : 0.35, 'moderate', 0.5, 'pine_eval', 0.7, 1]] as ExpressionSpecification
}

export const buildingColor: ExpressionSpecification = [
  'case',
  ['==', ['get', 'hazard_overlap'], true], VERDICT_STYLE.overlap.color,
  ['==', ['get', 'hazard_within_30m'], true], VERDICT_STYLE.within.color,
  VERDICT_STYLE.none.color,
]

export const buildingOutline: ExpressionSpecification = [
  'case',
  ['==', ['get', 'coverage_complete'], false], '#e2e8f0',
  ['==', ['get', 'needs_evaluation'], true], '#c084fc',
  '#0f172a',
]

export const LEAFOFF_COLORS = ['#e7c9a0', '#b07a3a', '#6b3f12'] // class 1..3, earthy so it never reads as a hazard class

export function satelliteLayer(): LayerSpecification {
  return { id: L.satellite, type: 'raster', source: SATELLITE_SOURCE, paint: { 'raster-saturation': -0.25, 'raster-brightness-max': 0.9 } }
}

export function satelliteSource() {
  return {
    type: 'raster' as const,
    tiles: [`${ESRI_IMAGERY}/tile/{z}/{y}/{x}`],
    tileSize: 256,
    maxzoom: 17,
    attribution: 'Imagery © Esri, Vantor/Maxar, Earthstar Geographics',
  }
}

export function drynessSource() {
  const q = `service=WMS&version=1.1.1&request=GetMap&layers=fwi_current&styles=&srs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true`
  return { type: 'raster' as const, tiles: [`${CWFIS_WMS}?${q}`], tileSize: 256, attribution: 'Fire weather © Natural Resources Canada (CWFIS)' }
}

export function drynessLayer(): LayerSpecification {
  return { id: L.dryness, type: 'raster', source: DRYNESS_SOURCE, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.35 } }
}

export function leafoffLayer(): LayerSpecification {
  return {
    id: L.leafoff,
    type: 'fill',
    source: LEAFOFF_SOURCE,
    'source-layer': 'leafoff',
    layout: { visibility: 'none' },
    paint: {
      'fill-color': ['match', ['get', 'drop_class'], 1, LEAFOFF_COLORS[0], 2, LEAFOFF_COLORS[1], LEAFOFF_COLORS[2]],
      'fill-opacity': ['match', ['get', 'drop_class'], 1, 0.3, 2, 0.45, 0.6],
      'fill-antialias': false,
    },
  }
}

export function hazardLayer(cats: Categories, opacity: number, satellite = false): LayerSpecification {
  return {
    id: L.hazardFill,
    type: 'fill',
    source: HAZARD_SOURCE,
    'source-layer': 'hazard',
    paint: { 'fill-color': hazardColor(cats), 'fill-opacity': hazardOpacity(opacity, satellite), 'fill-antialias': false },
  }
}

export function buildingLayers(): LayerSpecification[] {
  return [
    {
      id: L.buildingsFill,
      type: 'fill',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      paint: { 'fill-color': buildingColor, 'fill-opacity': 0.9 },
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

export const NO_SELECTION: ExpressionSpecification = ['==', ['id'], -1]

export function selectedLayers(): LayerSpecification[] {
  return [
    {
      id: L.selectedRing,
      type: 'fill',
      source: BUILDINGS_SOURCE,
      'source-layer': 'rings',
      filter: NO_SELECTION,
      paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.2, 'fill-outline-color': '#67e8f9' },
    },
    {
      id: L.selectedOutline,
      type: 'line',
      source: SELECTED_SOURCE,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#22d3ee', 'line-width': 3 },
    },
  ]
}

export function firstSymbolLayer(layers: LayerSpecification[]): string | undefined {
  return layers.find((l) => l.type === 'symbol')?.id
}

/** Basemap layers that should hide under satellite imagery (everything except labels). */
export function basemapLayerIds(style: StyleSpecification): string[] {
  return style.layers.filter((l) => l.type !== 'symbol' && !l.id.startsWith('wf-')).map((l) => l.id)
}
