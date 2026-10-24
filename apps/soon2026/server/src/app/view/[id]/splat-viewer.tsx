'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import styles from './splat-viewer.module.css';

/** A capture's splat, refreshed as training produces newer snapshots. */
export function SplatViewer({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('loading…');

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    // three.js and Spark need the browser, so the scene loads only there.
    import('./splat-scene').then(({ SplatScene }) => {
      if (disposed || !container.current) return;
      const scene = new SplatScene(container.current, id, setStatus);
      dispose = () => scene.dispose();
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [id]);

  return (
    <div ref={container} className={styles.root}>
      <div className={styles.hud}>
        <Link href="/">All captures</Link> · <span>{status}</span>
      </div>
    </div>
  );
}
