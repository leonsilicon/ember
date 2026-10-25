import { normalizeUsername } from '#rooms.ts';
import { requireSignIn } from '#web/auth.ts';

import { LiveApp } from '../client';
import { LiveViewer } from './live-viewer';

/**
 * Live 3D: follows whichever phone in the browser's room (the username it signed in as) started
 * streaming most recently, in Ember's shell with the captures beside it. `?embed` is the app's
 * floating view: the reconstruction alone, following `?room=` (the username the app is set to).
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSignIn('/live');
  const params = await searchParams;
  if ('embed' in params) return <LiveViewer session={null} room={normalizeUsername(typeof params.room === 'string' ? params.room : null)} />;
  return <LiveApp session={null} />;
}
