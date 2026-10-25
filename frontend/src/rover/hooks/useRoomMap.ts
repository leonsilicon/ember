import { parseLiveMap } from '@rover-brain'
import { useEffect, useState } from 'react'
import { appendTrail, type LiveMapStream } from './useLiveMap'

/** After the socket closes (the server closes them every few minutes), open a new one this soon. */
const RETRY_MS = 1000

export type RoomMapStream = LiveMapStream & {
  connection: 'off' | 'connecting' | 'open' | 'reconnecting'
  /** The room the server put this browser in: its username; null when it signed in with the token. */
  room: string | null
}

const EMPTY: Pick<RoomMapStream, 'map' | 'receivedAt' | 'trail' | 'silent'> = { map: null, receivedAt: 0, trail: [], silent: false }

/**
 * The rover brain's map from the phone set to this browser's username, through the server
 * (`/live/map`, web/rooms.ts), for when the phone isn't on this Wi-Fi (the site on Vercel): the
 * same lines useLiveMap reads from a linked phone over the Wi-Fi. The room is the username the
 * browser signed in as; the server says which (`room`) as the socket opens.
 */
export function useRoomMap(enabled: boolean): RoomMapStream {
  const [stream, setStream] = useState(EMPTY)
  /** Null until the socket first opens (connecting), then whether it's open or being reopened. */
  const [socket, setSocket] = useState<'open' | 'reconnecting' | null>(null)
  const [room, setRoom] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let ws: WebSocket | null = null
    let retry: number | undefined
    const connect = () => {
      const url = new URL('/live/map', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url)
      ws = socket
      socket.onopen = () => setSocket('open')
      socket.onmessage = (event: MessageEvent<string>) => {
        if (typeof event.data !== 'string') return
        const map = parseLiveMap(event.data)
        if (map) {
          const at = performance.now()
          setStream((s) => ({ ...s, map, receivedAt: at, trail: appendTrail(s.trail, map.rover) }))
          return
        }
        try {
          const message = JSON.parse(event.data) as { type?: string; room?: string | null }
          if (message.type === 'room') setRoom(message.room ?? null)
        } catch {
          // Not for this page.
        }
      }
      socket.onclose = () => {
        if (disposed) return
        setSocket('reconnecting')
        retry = window.setTimeout(connect, RETRY_MS)
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(retry)
      if (ws) {
        ws.onclose = null
        ws.close()
      }
      setStream(EMPTY)
      setSocket(null)
    }
  }, [enabled])

  return { ...stream, connection: !enabled ? 'off' : (socket ?? 'connecting'), room }
}
