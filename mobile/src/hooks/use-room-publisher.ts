import { useCallback, useEffect, useRef, useState } from 'react';

import { roomMapIngestUrl } from '@/lib/splat-server';

/** The socket that carries the live map to the username's room on the splat server. */
export type RoomLink =
  /** No username, or nothing to send (the camera screen isn't on the back camera). */
  | { state: 'off' }
  | { state: 'connecting' | 'open' | 'reconnecting'; viewers: number; error?: string };

/** After the socket closes (the server closes them every few minutes), open a new one this soon. */
const RETRY_MS = 2000;
/** While nothing else is sent: an idle socket to a Vercel function dies without a close. The server doesn't pass it on. */
const PING_MS = 20_000;
const PING = '{"type":"ping"}';

/**
 * Sends the rover brain's map lines to the username's room on the splat server (`/live/map/ingest`,
 * frontend/src/web/rooms.ts), for the control page's top view when the laptop isn't on this Wi-Fi
 * (the site on Vercel). The server says how many browsers are watching the room; nothing is sent
 * while none are, so a phone left on its camera screen costs it nothing. `publish` takes a map
 * line (lib/rover-brain/live-map.ts) and sends it if anyone's watching.
 */
export function useRoomPublisher(serverUrl: string, username: string, enabled: boolean) {
  const [link, setLink] = useState<RoomLink>({ state: 'off' });
  const socket = useRef<WebSocket | null>(null);
  const viewers = useRef(0);
  const on = enabled && Boolean(username);

  useEffect(() => {
    if (!on) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const connect = () => {
      const ws = new WebSocket(roomMapIngestUrl(serverUrl, username));
      socket.current = ws;
      ws.onopen = () => {
        setLink({ state: 'open', viewers: viewers.current });
        ping = setInterval(() => ws.send(PING), PING_MS);
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; viewers?: number };
          if (message.type !== 'watching') return;
          viewers.current = message.viewers ?? 0;
          setLink((l) => (l.state === 'off' ? l : { ...l, viewers: viewers.current }));
        } catch {
          // Not for us.
        }
      };
      ws.onerror = (event) => {
        const error = (event as { message?: string }).message;
        setLink((l) => (l.state === 'off' ? l : { ...l, error }));
      };
      ws.onclose = () => {
        if (ping) clearInterval(ping);
        if (disposed) return;
        socket.current = null;
        viewers.current = 0;
        setLink((l) => ({ state: 'reconnecting', viewers: 0, error: l.state === 'off' ? undefined : l.error }));
        retry = setTimeout(connect, RETRY_MS);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      if (ping) clearInterval(ping);
      socket.current?.close();
      socket.current = null;
      viewers.current = 0;
    };
  }, [on, serverUrl, username]);

  const publish = useCallback((json: string) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN && viewers.current > 0) ws.send(json);
  }, []);

  const shown: RoomLink = !on ? { state: 'off' } : link.state === 'off' ? { state: 'connecting', viewers: 0 } : link;
  return { link: shown, publish };
}
