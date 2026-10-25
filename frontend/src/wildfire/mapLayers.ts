import type { ExpressionSpecification, LayerSpecification, Map as MLMap, StyleSpecification } from 'maplibre-gl'
import { ESRI_IMAGERY } from './live'
import { BAND, CRITICAL, ELEVATED } from './types'

export const BASEMAP = 'https://tiles.openfreemap.org/styles/dark'
export const BUILDINGS_SOURCE = 'wf-buildings'
export const SATELLITE_SOURCE = 'wf-satellite'
export const ISO_SOURCE = 'wf-isochrones'
export const BREAKS_SOURCE = 'wf-breaks'
export const ZONES_SOURCE = 'wf-zones'
export const ZONE_POINTS_SOURCE = 'wf-zone-points'
export const DENSITY_SOURCE = 'wf-density'
export const SUGGEST_SOURCE = 'wf-suggest'
export const FLAME_IMAGE = 'wf-flame'
export const ZONE_ORANGE = '#ff8a1f'
export const L = {
  satellite: 'wf-satellite',
  buildingsFill: 'wf-buildings-fill',
  buildingsLine: 'wf-buildings-line',
  buildingsGlow: 'wf-buildings-glow',
  selectedRing: 'wf-selected-ring',
  isoLine: 'wf-iso-line',
  isoLabel: 'wf-iso-label',
  breaksLine: 'wf-breaks-line',
  fire: 'wf-fire',
  zonesGlow: 'wf-zones-glow',
  zonesFill: 'wf-zones-fill',
  zonesLine: 'wf-zones-line',
  zonesIcon: 'wf-zones-icon',
  densityCircle: 'wf-density-circle',
  densityCount: 'wf-density-count',
  suggestLine: 'wf-suggest-line',
} as const

export function satelliteLayer(): LayerSpecification {
  return { id: L.satellite, type: 'raster', source: SATELLITE_SOURCE, paint: { 'raster-saturation': -0.35, 'raster-brightness-max': 0.8, 'raster-contrast': 0.1 } }
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

/** Today's Ignition Risk from the static exposure baked into the tiles: 100 × exposure × multiplier. */
export const riskExpr = (multiplier: number): ExpressionSpecification => ['round', ['*', 100 * multiplier, ['to-number', ['get', 'exposure'], 0]]]

export function riskColor(multiplier: number): ExpressionSpecification {
  return ['step', riskExpr(multiplier), BAND.low.color, ELEVATED, BAND.elevated.color, CRITICAL, BAND.critical.color]
}

/** Homes the simulation has ignited get a feature-state `ignited` flag; the footprint turns black-orange. */
const IGNITED = ['boolean', ['feature-state', 'ignited'], false] as ExpressionSpecification
const CLEARED = ['boolean', ['feature-state', 'cleared'], false] as ExpressionSpecification
const SELECTED = ['boolean', ['feature-state', 'selected'], false] as ExpressionSpecification
const lineColor = (multiplier: number): ExpressionSpecification => ['case', SELECTED, '#48aff0', IGNITED, '#ff6e00', CLEARED, '#3dcc91', riskColor(multiplier)]

const ROUND = { 'line-join': 'round', 'line-cap': 'round' } as const

export function buildingLayers(multiplier: number): LayerSpecification[] {
  return [
    {
      id: L.buildingsGlow,
      type: 'line',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      minzoom: 12,
      filter: ['>=', riskExpr(multiplier), ELEVATED],
      layout: ROUND,
      paint: { 'line-color': riskColor(multiplier), 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 8], 'line-blur': 6, 'line-opacity': 0.55 },
    },
    {
      id: L.buildingsFill,
      type: 'fill',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      paint: {
        'fill-color': ['case', IGNITED, '#1a0a05', CLEARED, '#3dcc91', riskColor(multiplier)],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, ['case', IGNITED, 0.95, 0.55], 15, ['case', IGNITED, 0.95, 0.9]],
      },
    },
    {
      id: L.buildingsLine,
      type: 'line',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      minzoom: 13,
      layout: ROUND,
      paint: { 'line-color': lineColor(multiplier), 'line-width': ['case', SELECTED, 3, IGNITED, 1.5, 0.7], 'line-opacity': 0.9 },
    },
  ]
}

export function restyleBuildings(map: MLMap, multiplier: number) {
  if (!map.getLayer(L.buildingsFill)) return
  map.setFilter(L.buildingsGlow, ['>=', riskExpr(multiplier), ELEVATED])
  map.setPaintProperty(L.buildingsGlow, 'line-color', riskColor(multiplier))
  map.setPaintProperty(L.buildingsFill, 'fill-color', ['case', IGNITED, '#1a0a05', CLEARED, '#3dcc91', riskColor(multiplier)])
  map.setPaintProperty(L.buildingsLine, 'line-color', lineColor(multiplier))
}

export const NO_SELECTION: ExpressionSpecification = ['==', ['id'], -1]

export function selectedLayers(): LayerSpecification[] {
  return [
    {
      id: L.selectedRing,
      type: 'line',
      source: BUILDINGS_SOURCE,
      'source-layer': 'rings',
      filter: NO_SELECTION,
      layout: ROUND,
      paint: { 'line-color': '#48aff0', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
    },
  ]
}

export function isochroneLayers(): LayerSpecification[] {
  return [
    {
      id: L.isoLine,
      type: 'line',
      source: ISO_SOURCE,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['interpolate', ['linear'], ['get', 'minutes'], 60, '#ffe39f', 180, '#ffb366', 360, '#ff7373', 720, '#c22762'],
        'line-width': 1.5,
        'line-opacity': 0.35,
        'line-dasharray': [4, 3],
      },
    },
    {
      id: L.isoLabel,
      type: 'symbol',
      source: ISO_SOURCE,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Noto Sans Regular'], 'symbol-spacing': 400 },
      paint: { 'text-color': '#f6f7f9', 'text-halo-color': '#10161a', 'text-halo-width': 1.2 },
    },
  ]
}

export function breaksLayer(): LayerSpecification {
  return {
    id: L.breaksLine,
    type: 'line',
    source: BREAKS_SOURCE,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#3dcc91', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 2, 18, 40], 'line-opacity': 0.75 },
  }
}

export function firstSymbolLayer(layers: LayerSpecification[]): string | undefined {
  return layers.find((l) => l.type === 'symbol')?.id
}

/** Basemap layers that should hide under satellite imagery (everything except labels). */
export function basemapLayerIds(style: StyleSpecification): string[] {
  return style.layers.filter((l) => l.type !== 'symbol' && l.type !== 'background').map((l) => l.id)
}

const ZSEL = ['boolean', ['feature-state', 'selected'], false] as ExpressionSpecification
const ZHOVER = ['boolean', ['feature-state', 'hover'], false] as ExpressionSpecification

/** High fire-risk zones: one orange, soft glowing edge, one flame per zone (collisions hide the smaller ones). */
export function zoneLayers(): LayerSpecification[] {
  return [
    {
      id: L.zonesGlow,
      type: 'line',
      source: ZONES_SOURCE,
      layout: ROUND,
      paint: { 'line-color': ZONE_ORANGE, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 14], 'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 12], 'line-opacity': 0.45 },
    },
    {
      id: L.zonesFill,
      type: 'fill',
      source: ZONES_SOURCE,
      paint: { 'fill-color': ZONE_ORANGE, 'fill-opacity': ['case', ZSEL, 0.45, ZHOVER, 0.36, 0.26] },
    },
    {
      id: L.zonesLine,
      type: 'line',
      source: ZONES_SOURCE,
      layout: ROUND,
      paint: { 'line-color': ['case', ZSEL, '#ffd9a8', ZONE_ORANGE], 'line-width': ['case', ZSEL, 2.5, 1.2], 'line-opacity': 0.9 },
    },
  ]
}

export function zoneIconLayer(): LayerSpecification {
  return {
    id: L.zonesIcon,
    type: 'symbol',
    source: ZONE_POINTS_SOURCE,
    layout: {
      'icon-image': FLAME_IMAGE,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 13, 0.75, 16, 1],
      'symbol-sort-key': ['-', 0, ['get', 'area_ha']],
      'icon-padding': 6,
    },
  }
}

/** Flame icon drawn on a canvas (MapLibre glyph fonts cannot render emoji). 64 px at pixelRatio 2. */
export function flameImage(): ImageData | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.translate(6, 4)
  ctx.scale(52 / 24, 56 / 24)
  const outer = new Path2D('M12 1.5C12.6 5 14.6 6.6 16.6 8.7 18.8 11 20 13.2 20 15.8 20 20 16.4 23 12 23S4 20 4 15.8C4 12.8 5.5 10.6 7.3 9.1 7.4 10.9 8.2 12.3 9.6 13 9.2 8.6 10.6 4.6 12 1.5Z')
  const inner = new Path2D('M12 12.2C13.6 13.8 15.6 15.3 15.6 17.7 15.6 19.7 14 21 12 21S8.4 19.7 8.4 17.7C8.4 15.9 9.7 14.6 10.9 13.5 11.1 14.6 11.6 15.3 12.3 15.6 12 14.5 11.9 13.4 12 12.2Z')
  const g = ctx.createLinearGradient(0, 23, 0, 1)
  g.addColorStop(0, '#e2401c')
  g.addColorStop(1, '#ff9a2e')
  ctx.lineWidth = 1.4
  ctx.strokeStyle = 'rgba(16,22,26,0.8)'
  ctx.stroke(outer)
  ctx.fillStyle = g
  ctx.fill(outer)
  ctx.fillStyle = '#ffd54a'
  ctx.fill(inner)
  return ctx.getImageData(0, 0, 64, 64)
}

/** Building density: clusters of building centroids as blue circles sized by count. */
export function densityLayers(): LayerSpecification[] {
  return [
    {
      id: L.densityCircle,
      type: 'circle',
      source: DENSITY_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'circle-color': '#2d72d2',
        'circle-opacity': 0.35,
        'circle-stroke-color': '#8abbff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.6,
        'circle-radius': ['case', ['has', 'point_count'], ['step', ['get', 'point_count'], 12, 20, 18, 100, 26, 400, 36, 1000, 46], 3],
      },
    },
    {
      id: L.densityCount,
      type: 'symbol',
      source: DENSITY_SOURCE,
      filter: ['has', 'point_count'],
      layout: { visibility: 'none', 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
      paint: { 'text-color': '#dbe9ff', 'text-halo-color': '#10161a', 'text-halo-width': 1 },
    },
  ]
}

/** Suggested fuel breaks, dashed until applied. */
export function suggestLayer(): LayerSpecification {
  return {
    id: L.suggestLine,
    type: 'line',
    source: SUGGEST_SOURCE,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': '#3dcc91',
      'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 2, 18, 40],
      'line-opacity': 0.6,
      'line-dasharray': [1, 1],
    },
  }
}
