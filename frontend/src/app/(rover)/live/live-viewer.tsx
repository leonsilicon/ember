'use client';

import { useRef } from 'react';

import { useLiveReconstruction } from './live-reconstruction';
import styles from './live-viewer.module.css';

/**
 * The app's view of the live reconstruction (`?embed`; the app's live-splat-view.tsx): the scene
 * alone, on black, with a line while there's nothing to see yet. The browser's page is live-app.tsx.
 */
export function LiveViewer({ session }: { session: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  const live = useLiveReconstruction(container, session, true);
  return (
    <div ref={container} className={styles.root}>
      {!live.hasPoints && (
        <div className={styles.empty}>
          <div>
            {!live.agentOnline ? (
              <strong>The Mac agent is offline</strong>
            ) : (
              <>
                <strong>Live 3D</strong>
                {live.stats && !live.stats.fused && live.stats.lastSkip ? live.stats.lastSkip : 'Waiting for the first keyframe…'}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
