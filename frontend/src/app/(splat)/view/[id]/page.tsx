import { notFound } from 'next/navigation';

import { ToolShell } from '#app/tool-shell.tsx';
import { requireSignIn } from '#web/auth.ts';
import { CAPTURE_ID } from '#web/http.ts';
import { jobStore } from '#web/redis.ts';

import { SplatViewer } from './splat-viewer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Splat viewer' };
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };

/** A capture's splat, reached from the Live 3D tab's captures; no tab is lit. */
export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSignIn(`/view/${encodeURIComponent(id)}`);
  if (!CAPTURE_ID.test(id) || !(await jobStore().get(id))) notFound();
  return (
    <ToolShell>
      <SplatViewer id={id} />
    </ToolShell>
  );
}
