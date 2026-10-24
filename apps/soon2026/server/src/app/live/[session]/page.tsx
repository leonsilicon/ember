import { notFound } from 'next/navigation';

import { signedIn } from '#web/auth.ts';
import { CAPTURE_ID } from '#web/http.ts';

import { SignIn } from '../../sign-in';
import { LiveViewer } from '../live-viewer';

/** One recording, by its capture id (the app opens this as the recording starts, with `?embed`). */
export default async function LiveSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ session: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await signedIn())) return <SignIn />;
  const { session } = await params;
  if (!CAPTURE_ID.test(session)) notFound();
  return <LiveViewer session={session} embed={'embed' in (await searchParams)} />;
}
