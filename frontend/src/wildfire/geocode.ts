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
