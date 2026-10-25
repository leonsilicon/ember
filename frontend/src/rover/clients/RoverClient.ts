import { DEFAULT_POWER, DEFAULT_SPEED, type MotionState, type StatusReport } from '../protocol'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'
export type ClientKind = 'simulated' | 'rover'

export interface RoverSnapshot {
  kind: ClientKind
  connection: ConnectionState
  /** What the client is asking for: the state of the last frame sent (or, before connecting, the one it will send). */
  motion: MotionState
  /** The rover's latest /status report (the simulator's own state); null before the first one. */
  status: StatusReport | null
  /** Timestamp of the last reply from the device, null if none yet. */
  lastMessageAt: number | null
  lastError: string | null
}

export interface RoverClient {
  readonly kind: ClientKind
  connect(): void
  disconnect(): void
  /** Changes the desired state and sends it as a frame (power and speed changes apply even while stopped). */
  set(patch: Partial<MotionState>): void
  /** Zeroes wheel, pan and lift; power and speed stay. */
  stop(): void
  getSnapshot(): RoverSnapshot
  subscribe(listener: () => void): () => void
}

export function initialSnapshot(kind: ClientKind): RoverSnapshot {
  return {
    kind,
    connection: 'disconnected',
    motion: { wheel: 0, pan: 0, lift: 0, power: DEFAULT_POWER, speed: DEFAULT_SPEED },
    status: null,
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
  abstract set(patch: Partial<MotionState>): void

  stop(): void {
    this.set({ wheel: 0, pan: 0, lift: 0 })
  }

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
