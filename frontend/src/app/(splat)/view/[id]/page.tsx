import { notFound } from 'next/navigation';

import { requireSignIn } from '#web/auth.ts';
import { CAPTURE_ID } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

import { SplatViewer } from './splat-viewer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Splat viewer' };
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };

export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSignIn(`/view/${encodeURIComponent(id)}`);
  if (!CAPTURE_ID.test(id) || !(await jobStore().get(id))) notFound();
  return <SplatViewer id={id} />;
}
