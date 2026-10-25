import { ToolShell } from '#app/tool-shell.tsx';
import { requireSignIn } from '#web/auth.ts';

import { Refresh } from '../refresh';
import { CapturesPanel } from './captures-panel';
import { LiveViewer } from './live-viewer';

export const dynamic = 'force-dynamic';

/**
 * The Live 3D tab: follows whichever phone started streaming most recently, with the captures as
 * they train. `?embed` is the app's floating view: the reconstruction alone.
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSignIn('/live');
  if ('embed' in (await searchParams)) return <LiveViewer session={null} embed />;
  return (
    <ToolShell current="/live">
      <LiveViewer session={null} embed={false} />
      <CapturesPanel />
      <Refresh every={3000} />
    </ToolShell>
  );
}
