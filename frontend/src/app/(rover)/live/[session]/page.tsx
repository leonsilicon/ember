import { notFound } from 'next/navigation';

import { requireSignIn } from '#web/auth.ts';
import { CAPTURE_ID } from '#web/http.ts';

import { LiveApp } from '../../client';
import { LiveViewer } from '../live-viewer';

/** One recording, by its capture id (the app opens this as the recording starts, with `?embed`). */
export default async function LiveSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ session: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session } = await params;
  await requireSignIn(`/live/${encodeURIComponent(session)}`);
  if (!CAPTURE_ID.test(session)) notFound();
  if ('embed' in (await searchParams)) return <LiveViewer session={session} />;
  return <LiveApp session={session} />;
}
