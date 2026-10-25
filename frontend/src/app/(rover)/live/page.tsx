import { requireSignIn } from '#web/auth.ts';

import { LiveApp } from '../client';
import { LiveViewer } from './live-viewer';

/**
 * Live 3D: follows whichever phone started streaming most recently, in Ember's shell with the
 * captures beside it. `?embed` is the app's floating view: the reconstruction alone.
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSignIn('/live');
  if ('embed' in (await searchParams)) return <LiveViewer session={null} />;
  return <LiveApp session={null} />;
}
