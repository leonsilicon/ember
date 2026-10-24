import type { ArmState, Command, DriveCommand } from '../protocol'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'
export type ClientKind = 'simulated' | 'websocket'

export interface RoverSnapshot {
  kind: ClientKind
  connection: ConnectionState
  /** Drive state as reported by the device (or the simulator). */
  drive: DriveCommand
  arm: ArmState
  /** Timestamp of the last message from the device, null if none yet. */
  lastMessageAt: number | null
  lastError: string | null
}

export interface RoverClient {
  readonly kind: ClientKind
  connect(): void
  disconnect(): void
  send(cmd: Command): void
  getSnapshot(): RoverSnapshot
  subscribe(listener: () => void): () => void
}

export function initialSnapshot(kind: ClientKind): RoverSnapshot {
  return {
    kind,
    connection: 'disconnected',
    drive: 'stop',
    arm: 'idle',
    lastMessageAt: null,
    lastError: null,
  }
}

/** Small base class handling snapshot storage and subscriptions. */
export abstract class BaseRoverClient implements RoverClient {
  abstract readonly kind: ClientKind
  protected snapshot: RoverSnapshot
  private listeners = new Set<() => void>()

  constructor(kind: ClientKind) {
    this.snapshot = initialSnapshot(kind)
  }

  abstract connect(): void
  abstract disconnect(): void
  abstract send(cmd: Command): void

  getSnapshot(): RoverSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  protected update(patch: Partial<RoverSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
