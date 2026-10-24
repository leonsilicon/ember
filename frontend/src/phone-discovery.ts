import { Bonjour, type Browser, type Service } from 'bonjour-service'

/**
 * Finds the rover's iPhone on the local network, so the web app links up with its camera as soon as the
 * rover app opens. The app advertises its camera with Bonjour as `_rovercam._tcp` (CameraStreamServer in
 * mobile/modules/splat-capture); browsers can't see Bonjour, but the dev server can, and answers
 * `GET /api/phone-camera` (src/app/(rover)/api/phone-camera/route.ts) with the phones it has found that
 * are answering right now. On Vercel there's no local network to search, so the route finds none there.
 */

export const SERVICE_TYPE = 'rovercam'
export const API_PATH = '/api/phone-camera'
/** A phone that doesn't answer /status this fast is left out (an app killed without saying goodbye). */
const PROBE_TIMEOUT_MS = 1500
/** How long a listing is reused, so a page polling every couple of seconds doesn't probe more often. */
const CACHE_MS = 1500
/** How often to ask the network again, for phones whose announcement was missed. */
const REQUERY_MS = 10_000

export type DiscoveredPhone = {
  /** The Bonjour service name, e.g. "Rover camera (iPhone16,1)". */
  name: string
  /** The phone model the app reports, e.g. "iPhone16,1". */
  device: string
  /** Where its camera server is, e.g. "http://192.168.1.23:8787". */
  origin: string
}

function isIPv4(address: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address)
}

function toPhone(service: Service): DiscoveredPhone | null {
  // An IPv4 address works from any browser; the .local host name is the fallback.
  const address = (service.addresses ?? []).find(isIPv4) ?? service.host?.replace(/\.$/, '')
  if (!address || !service.port) return null
  const txt = (service.txt ?? {}) as Record<string, unknown>
  return {
    name: service.name,
    device: typeof txt.device === 'string' ? txt.device : service.name,
    origin: `http://${address}:${service.port}`,
  }
}

async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

export class PhoneDiscovery {
  private bonjour = new Bonjour()
  private browser: Browser
  private requery: ReturnType<typeof setInterval>
  private cached: { at: number; phones: Promise<DiscoveredPhone[]> } | null = null

  constructor() {
    this.browser = this.bonjour.find({ type: SERVICE_TYPE })
    this.requery = setInterval(() => this.browser.update(), REQUERY_MS)
  }

  /** Phones advertising the camera that answer right now, most recently announced first. */
  list(): Promise<DiscoveredPhone[]> {
    const now = Date.now()
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.phones
    const candidates = [...this.browser.services]
      .reverse()
      .map(toPhone)
      .filter((p): p is DiscoveredPhone => p != null)
    const unique = [...new Map(candidates.map((p) => [p.origin, p])).values()]
    const phones = Promise.all(unique.map(async (p) => ((await answers(p.origin)) ? p : null))).then((found) =>
      found.filter((p): p is DiscoveredPhone => p != null),
    )
    this.cached = { at: now, phones }
    return phones
  }

  stop() {
    clearInterval(this.requery)
    this.browser.stop()
    this.bonjour.destroy()
  }
}
