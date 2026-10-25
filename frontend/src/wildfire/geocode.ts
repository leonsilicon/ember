import { useEffect, useState } from 'react'

export interface GeocodeHit {
  id: string
  label: string
  detail: string
  lon: number
  lat: number
}

const PHOTON = 'https://photon.komoot.io/api/'

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: Record<string, string | number | undefined> & { osm_id?: number; osm_type?: string }
}

export async function geocode(
  q: string,
  bias: { lon: number; lat: number },
  signal: AbortSignal,
): Promise<GeocodeHit[]> {
  const url = new URL(PHOTON)
  url.searchParams.set('q', q)
  url.searchParams.set('limit', '6')
  url.searchParams.set('lang', 'en')
  url.searchParams.set('lon', String(bias.lon))
  url.searchParams.set('lat', String(bias.lat))
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Photon ${res.status}`)
  const data = (await res.json()) as { features: PhotonFeature[] }
  return data.features.map((f, i) => {
    const p = f.properties
    const line1 = [p.housenumber, p.name ?? p.street].filter(Boolean).join(' ') || String(p.street ?? p.city ?? '')
    const line2 = [p.street && p.name ? p.street : null, p.city ?? p.town ?? p.village, p.state, p.country]
      .filter(Boolean)
      .join(', ')
    return {
      id: `${p.osm_type ?? 'x'}${p.osm_id ?? i}`,
      label: line1,
      detail: line2,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }
  })
}

const placeCache = new Map<string, Promise<string | null>>()

// Photon's public server rate-limits bursts (and then answers without CORS headers), so reverse lookups go one at a time.
const REVERSE_GAP_MS = 350
let reverseQueue: Promise<unknown> = Promise.resolve()
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const p = reverseQueue.then(fn)
  reverseQueue = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, REVERSE_GAP_MS)))
  return p
}

/** Nearest named place (street, creek, lake…) and its town, via Photon reverse geocoding; null if none or offline. */
export function reverseGeocode(lon: number, lat: number): Promise<string | null> {
  const key = `${lon.toFixed(4)},${lat.toFixed(4)}`
  let p = placeCache.get(key)
  if (!p) {
    const url = new URL('https://photon.komoot.io/reverse')
    url.searchParams.set('lon', lon.toFixed(5))
    url.searchParams.set('lat', lat.toFixed(5))
    url.searchParams.set('lang', 'en')
    url.searchParams.set('limit', '1')
    p = queued(() => fetch(url))
      .then((r) => (r.ok ? (r.json() as Promise<{ features: PhotonFeature[] }>) : null))
      .then((d) => {
        const q = d?.features?.[0]?.properties
        if (!q) return null
        const line1 = [q.housenumber, q.street ?? q.name].filter(Boolean).join(' ')
        const town = q.city ?? q.town ?? q.village ?? q.county
        return [line1, town].filter(Boolean).join(', ') || null
      })
      .catch(() => {
        placeCache.delete(key)
        return null
      })
    placeCache.set(key, p)
  }
  return p
}

/** Real-world name for a point, or null while loading / when nothing is nearby. */
export function usePlaceName(lon: number | null | undefined, lat: number | null | undefined): string | null {
  const key = lon != null && lat != null ? `${lon},${lat}` : null
  const [name, setName] = useState<{ key: string; name: string | null } | null>(null)
  useEffect(() => {
    if (key == null) return
    let live = true
    const [x, y] = key.split(',').map(Number)
    reverseGeocode(x, y).then((n) => live && setName({ key, name: n }))
    return () => {
      live = false
    }
  }, [key])
  return name && name.key === key ? name.name : null
}
