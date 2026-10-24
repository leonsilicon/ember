/** The rover app serves its camera on this port (apps/expo-app/src/hooks/use-camera-stream.ts). */
export const PHONE_CAMERA_PORT = 8787

/** "192.168.1.23", "192.168.1.23:8787" or a full URL → "http://192.168.1.23:8787", or null if unusable. */
export function phoneCameraOrigin(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`)
    if (!url.port) url.port = String(PHONE_CAMERA_PORT)
    return url.origin
  } catch {
    return null
  }
}

/** A phone the dev server found on the Wi-Fi (the shape of phone-discovery.ts's DiscoveredPhone). */
type FoundPhone = { origin: string; id?: string }

/** The phone used last: its id (stable), and its address (for builds without an id). */
export type LastPhone = { id: string | null; origin: string | null }

/**
 * Which found phone to link up with by itself: the one used last, and only that one, since on a shared
 * Wi-Fi teammates' phones (and stand-ins) show up too. It's recognised by its id, which survives the Wi-Fi
 * handing it a new address, or by its address for builds without one. The very first time, with none
 * used yet, the only one found. Otherwise none: the panel lists them to pick from.
 */
export function pickPhone<P extends FoundPhone>(phones: readonly P[], last: LastPhone): P | null {
  if (last.id) {
    const byId = phones.find((p) => p.id === last.id)
    if (byId) return byId
  }
  if (last.origin) return phones.find((p) => !p.id && p.origin === last.origin) ?? null
  if (last.id) return null
  return phones.length === 1 ? phones[0] : null
}
