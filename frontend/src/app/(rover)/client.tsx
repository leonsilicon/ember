'use client';

import dynamic from 'next/dynamic';

// These pages live in the browser (WebSockets to the rover, WebGL, the File System Access API,
// maplibre), so they're loaded on the client only and never rendered on the server.
const loading = () => <p className="p-6 text-sm text-[#6f6a63]">Loading…</p>;

export const ControlApp = dynamic(() => import('#rover/ControlApp.tsx'), { ssr: false, loading });
export const SimApp = dynamic(() => import('#rover/SimApp.tsx'), { ssr: false, loading });
export const WildfireApp = dynamic(() => import('#wildfire/WildfireApp.tsx'), { ssr: false, loading });
export const LiveApp = dynamic(() => import('./live/live-app'), { ssr: false, loading });
export const ViewApp = dynamic(() => import('./view/[id]/view-app'), { ssr: false, loading });
