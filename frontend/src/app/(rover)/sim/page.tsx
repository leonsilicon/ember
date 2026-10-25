import { requireSignIn } from '#web/auth.ts';

import { SimApp } from '../client';

export const metadata = { title: 'Autopilot sim' };

/** The rover's own brain (mobile/src/lib/rover-brain) clearing a virtual yard. */
export default async function SimPage() {
  await requireSignIn('/sim');
  return <SimApp />;
}
