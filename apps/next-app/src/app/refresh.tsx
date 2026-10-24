'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Renders the page again on the server every `every` ms, so training progress shows without a reload. */
export function Refresh({ every }: { every: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), every);
    return () => clearInterval(timer);
  }, [router, every]);
  return null;
}
