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
