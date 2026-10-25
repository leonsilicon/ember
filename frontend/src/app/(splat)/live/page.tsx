import { requireSignIn } from '#web/auth.ts';

import { LiveViewer } from './live-viewer';

/** Follows whichever phone started streaming most recently. `?embed` is the app's floating view. */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSignIn('/live');
  return <LiveViewer session={null} embed={'embed' in (await searchParams)} />;
}
