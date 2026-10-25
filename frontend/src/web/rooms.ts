import type Redis from 'ioredis';
import type { RawData, WebSocket } from 'ws';

import { connect } from '../bus';
import { k, redis } from './redis';

/**
 * The live map a phone sends to its room (see rooms.ts): the rover brain's map lines (JSON text,
 * mobile/src/lib/rover-brain/live-map.ts), relayed to every browser signed in as that username
 * through a Redis pub/sub channel per room, since a socket stays on the function instance that
 * accepted it. Unlike the Live 3D stream (relay.ts), nothing is computed on the way, so the Mac
 * agent isn't involved and the control page works without it. Messages aren't kept: a browser that
 * joins gets the next map line (the phone sends one every steering tick).
 *
 * A phone is told how many relays have a browser watching its room (`watching`), and sends nothing
 * while that's zero, so a phone left on its camera screen costs no Redis commands beyond one count
 * every few seconds.
 */

/** How often a phone's relay counts its room's watchers (PUBSUB NUMSUB: one command). */
export const WATCHERS_EVERY_MS = 5000;
/** A phone's keepalive, which isn't passed on (an idle socket to a function dies silently otherwise). */
export const PING = '{"type":"ping"}';

export type WatchingMessage = { type: 'watching'; viewers: number };
export type RoomMessage = { type: 'room'; room: string | null };

function text(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString();
}

class RoomRelay {
  /** Its own connection: a connection that subscribes can run nothing else. */
  private subscriber: Redis | null = null;
  /** The browsers watching each room, by channel. */
  private watching = new Map<string, Set<WebSocket>>();

  /** A browser watching a room: it gets every map line a phone sends there from now on. */
  async watch(ws: WebSocket, room: string | null) {
    ws.on('error', () => {});
    const hello: RoomMessage = { type: 'room', room };
    ws.send(JSON.stringify(hello));
    if (!room) return;
    const channel = k.room(room);
    let viewers = this.watching.get(channel);
    if (!viewers) {
      this.watching.set(channel, (viewers = new Set()));
      await this.subscribe().subscribe(channel).catch((error) => console.error('room subscribe', error));
    }
    viewers.add(ws);
    ws.on('close', () => {
      viewers!.delete(ws);
      if (viewers!.size) return;
      this.watching.delete(channel);
      this.subscriber?.unsubscribe(channel).catch((error) => console.error('room unsubscribe', error));
    });
  }

  /** A phone sending to a room: its text messages go to the room's watchers, and it's told how many there are. */
  async sendFrom(ws: WebSocket, room: string) {
    const channel = k.room(room);
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = text(data);
      if (message === PING) return;
      redis().publish(channel, message).catch((error) => console.error('room publish', error));
    });
    let last = -1;
    const report = async () => {
      try {
        const viewers = await this.watchers(room);
        if (viewers === last || ws.readyState !== ws.OPEN) return;
        last = viewers;
        const message: WatchingMessage = { type: 'watching', viewers };
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('room watchers', error);
      }
    };
    const timer = setInterval(() => void report(), WATCHERS_EVERY_MS);
    ws.on('close', () => clearInterval(timer));
    await report();
  }

  /** How many relays (function instances with a browser watching) are subscribed to the room. */
  async watchers(room: string): Promise<number> {
    const [, count] = (await redis().call('PUBSUB', 'NUMSUB', k.room(room))) as [string, number | string];
    return Number(count) || 0;
  }

  private subscribe() {
    if (!this.subscriber) {
      this.subscriber = connect();
      this.subscriber.on('message', (channel: string, message: string) => {
        for (const ws of this.watching.get(channel) ?? []) if (ws.readyState === ws.OPEN) ws.send(message);
      });
    }
    return this.subscriber;
  }
}

let relay: RoomRelay | null = null;

/** This instance's room relay (one per instance: Fluid compute runs many sockets in one). */
export function roomRelay() {
  relay ??= new RoomRelay();
  return relay;
}
