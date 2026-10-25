import { ToolShell } from '#app/tool-shell.tsx';
import { requireSignIn } from '#web/auth.ts';

import { ControlApp } from '../client';

export const metadata = { title: 'Rover Control' };

/** The laptop remote for the rover and arm, with the splat viewer and the capture panel. */
export default async function ControlPage() {
  await requireSignIn('/control');
  return (
    <ToolShell current="/control">
      <ControlApp />
    </ToolShell>
  );
}
