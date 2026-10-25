import { DEFAULT_ROVER_URL } from '#rover/protocol.ts';

/**
 * Where the rover proxy (app/(rover)/api/rover) forwards to. The rover's firmware has no CORS, so
 * the browser calls this server, which calls the rover. The address is ROVER_URL, else the rover's
 * own Wi-Fi address, and the page may name another with `?rover=` (a mock on this laptop, say), but
 * only one on a local network: this is not an open relay.
 */
export function roverTarget(request: Request): { url: string } | { error: string; status: number } {
  const asked = new URL(request.url).searchParams.get('rover');
  const raw = asked || process.env.ROVER_URL || DEFAULT_ROVER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Not a URL: ${raw}`, status: 400 };
  }
  if (url.protocol !== 'http:') return { error: 'The rover speaks plain http', status: 400 };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { error: 'The rover address is an origin only, like http://192.168.4.1', status: 400 };
  }
  if (!localHost(url.hostname)) return { error: `Not a local network address: ${url.hostname}`, status: 403 };
  return { url: url.origin };
}

/** Loopback, RFC 1918, link-local and `.local` names: the networks a rover can be on. */
export function localHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
