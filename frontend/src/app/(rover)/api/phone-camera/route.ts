import { PhoneDiscovery, type DiscoveredPhone } from '#phone-discovery.ts';

export const dynamic = 'force-dynamic';

// One Bonjour browser for the process, kept across the dev server's reloads.
const shared = globalThis as typeof globalThis & { roverPhoneDiscovery?: PhoneDiscovery };

/**
 * The phones on the Wi-Fi advertising the rover app's camera, for the Control page (see
 * src/phone-discovery.ts). None on Vercel: a function has no local network to search.
 */
export async function GET() {
  let phones: DiscoveredPhone[] = [];
  if (!process.env.VERCEL) {
    shared.roverPhoneDiscovery ??= new PhoneDiscovery();
    phones = await shared.roverPhoneDiscovery.list();
  }
  return Response.json({ phones }, { headers: { 'Cache-Control': 'no-store' } });
}
