import { notFound } from 'next/navigation';

import { requireSignIn } from '#web/auth.ts';
import { CAPTURE_ID } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

import { ViewApp } from '../../client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Splat viewer' };
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };

/** A capture's splat in Ember's shell, reached from Live 3D's captures (that page stays lit). */
export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSignIn(`/view/${encodeURIComponent(id)}`);
  if (!CAPTURE_ID.test(id) || !(await jobStore().get(id))) notFound();
  return <ViewApp id={id} />;
}
