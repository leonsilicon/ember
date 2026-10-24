import { signedIn } from '#web/auth.ts';

import { SignIn } from '../sign-in';
import { LiveViewer } from './live-viewer';

/** Follows whichever phone started streaming most recently. `?embed` is the app's floating view. */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await signedIn())) return <SignIn />;
  return <LiveViewer session={null} embed={'embed' in (await searchParams)} />;
}
