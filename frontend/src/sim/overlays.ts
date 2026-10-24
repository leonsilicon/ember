/** Toggleable layers, shared by the 2D and 3D views. Truth leaves, obstacles and the rover always draw. */
export type Overlays = {
  trail: boolean
  fov: boolean
  corridors: boolean
  belief: boolean
  pileZone: boolean
  /** Decorative ground leaves (3D only). */
  litter: boolean
}

export const DEFAULT_OVERLAYS: Overlays = {
  trail: true,
  fov: true,
  corridors: true,
  belief: true,
  pileZone: true,
  litter: true,
}

/** The reference viewer's dark-theme colours (grid swapped for the app's zinc). */
export const PALETTE = {
  background: '#18181b',
  grid: '#27272a',
  pile: '#e0953a',
  pileFill: 'rgba(224,149,58,.12)',
  obstacle: '#9a978f',
  leaf: '#d4a24c',
  leafPiled: '#8a6a3a',
  belief: '#60a5fa',
  open: 'rgba(74,222,128,.5)',
  blocked: '#f87171',
  rover: '#ecebe7',
  roverFill: 'rgba(236,235,231,.12)',
  scoopDown: '#4ade80',
  trail: 'rgba(96,165,250,.35)',
  fov: 'rgba(96,165,250,.08)',
  muted: '#8f8c85',
}
