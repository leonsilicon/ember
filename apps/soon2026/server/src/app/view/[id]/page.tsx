import { notFound } from 'next/navigation';

import { signedIn } from '#web/auth.ts';
import { CAPTURE_ID } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

import { SignIn } from '../../sign-in';
import { SplatViewer } from './splat-viewer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Splat viewer' };
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };

export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await signedIn())) return <SignIn />;
  const { id } = await params;
  if (!CAPTURE_ID.test(id) || !(await jobStore().get(id))) notFound();
  return <SplatViewer id={id} />;
}
