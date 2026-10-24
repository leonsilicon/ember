import { parseDeviceMessage, type Command, type CommandMessage } from '../protocol'
import { BaseRoverClient } from './RoverClient'

/**
 * Talks to firmware/rover_ws over a WebSocket.
 * Does not auto-reconnect: after a drop the user reconnects explicitly, and no
 * motion command is ever re-sent on reconnect.
 */
export class WebSocketClient extends BaseRoverClient {
  readonly kind = 'websocket' as const
  private socket: WebSocket | null = null
  private readonly url: string

  constructor(url: string) {
    super('websocket')
    this.url = url
  }

  connect(): void {
    if (this.socket) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      this.update({ connection: 'error', lastError: err instanceof Error ? err.message : 'Invalid URL' })
      return
    }
    this.socket = socket
    this.update({ connection: 'connecting', lastError: null })

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.update({ connection: 'connected', lastMessageAt: Date.now() })
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      const msg = parseDeviceMessage(String(event.data))
      if (!msg) {
        this.update({ lastError: 'Unrecognized message from device', lastMessageAt: Date.now() })
        return
      }
      if (msg.type === 'status') {
        this.update({ drive: msg.drive, arm: msg.arm, lastMessageAt: Date.now() })
      } else {
        this.update({ lastError: msg.message, lastMessageAt: Date.now() })
      }
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.update({ connection: 'error', lastError: `Could not reach ${this.url}` })
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      const wasError = this.snapshot.connection === 'error'
      this.update({ connection: wasError ? 'error' : 'disconnected', drive: 'stop' })
    }
  }

  disconnect(): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
    this.update({ connection: 'disconnected', drive: 'stop' })
  }

  send(cmd: Command): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.update({ lastError: 'Not connected' })
      return
    }
    const message: CommandMessage = { cmd }
    this.socket.send(JSON.stringify(message))
  }
}
