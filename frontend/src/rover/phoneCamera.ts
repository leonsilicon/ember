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
type FoundPhone = { origin: string }

/**
 * Which found phone to link up with by itself: the one used last, and only that one, since on a shared
 * Wi-Fi teammates' phones (and stand-ins) show up too. The very first time, with none used yet, the
 * only one found. Otherwise none: the panel lists them to pick from.
 */
export function pickPhone<P extends FoundPhone>(phones: readonly P[], lastOrigin: string | null): P | null {
  if (lastOrigin) return phones.find((p) => p.origin === lastOrigin) ?? null
  return phones.length === 1 ? phones[0] : null
}
