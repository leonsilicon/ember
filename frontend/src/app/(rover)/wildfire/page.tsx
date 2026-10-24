import { WildfireApp } from '../client';

export const metadata = { title: 'Wildfire hazard map' };

/** Buildings and their wildfire hazard on a map, from the tiles in public/wildfire. */
export default function WildfirePage() {
  return <WildfireApp />;
}
