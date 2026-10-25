import { requireSignIn } from '#web/auth.ts';

import { WildfireApp } from '../client';

export const metadata = { title: 'Wildfire hazard map' };

/** Buildings and their wildfire hazard on a map, from the tiles in public/wildfire. */
export default async function WildfirePage() {
  await requireSignIn('/wildfire');
  return <WildfireApp />;
}
