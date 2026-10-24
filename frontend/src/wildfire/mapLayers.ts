import type { ExpressionSpecification, LayerSpecification, Map as MLMap, StyleSpecification } from 'maplibre-gl'
import { ESRI_IMAGERY } from './live'
import { BAND, CRITICAL, ELEVATED } from './types'

export const BASEMAP = 'https://tiles.openfreemap.org/styles/dark'
export const BUILDINGS_SOURCE = 'wf-buildings'
export const SATELLITE_SOURCE = 'wf-satellite'
export const ISO_SOURCE = 'wf-isochrones'
export const BREAKS_SOURCE = 'wf-breaks'
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

export function buildingLayers(multiplier: number): LayerSpecification[] {
  return [
    {
      id: L.buildingsGlow,
      type: 'line',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      minzoom: 12,
      filter: ['>=', riskExpr(multiplier), ELEVATED],
      paint: { 'line-color': riskColor(multiplier), 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 8], 'line-blur': 6, 'line-opacity': 0.55 },
    },
    {
      id: L.buildingsFill,
      type: 'fill',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      paint: {
        'fill-color': ['case', IGNITED, '#1a0a05', CLEARED, '#3dcc91', riskColor(multiplier)],
        'fill-opacity': ['case', IGNITED, 0.95, ['interpolate', ['linear'], ['zoom'], 11, 0.55, 15, 0.9]],
      },
    },
    {
      id: L.buildingsLine,
      type: 'line',
      source: BUILDINGS_SOURCE,
      'source-layer': 'buildings',
      minzoom: 13,
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
