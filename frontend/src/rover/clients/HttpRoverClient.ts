import {
  DEFAULT_ROVER_URL,
  encodeFrame,
  HEARTBEAT_MS,
  isMoving,
  MAX_SEQ,
  parseStatus,
  parseToken,
  percent,
  PROXY_BASE,
  REQUEST_TIMEOUT_MS,
  STATUS_POLL_MS,
  type Endpoint,
  type MotionState,
} from '../protocol'
import { BaseRoverClient } from './RoverClient'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Drives the real rover (firmware/DualServoBench) through the same-origin proxy, the way the
 * firmware expects (see protocol.ts):
 *
 * - `connect` opens a command session (POST /session) and polls /status while connected.
 * - every change sends the FULL desired state with a strictly increasing seq, and while anything
 *   is held the same state goes again every HEARTBEAT_MS, inside the firmware's lease.
 * - any failed request zeroes everything, sends one best-effort zero frame (a higher seq, keepalive,
 *   so it outlives a closing page) and drops to `error`: the firmware's lease is the fallback. A
 *   failure of an older frame than the latest is ignored (a newer frame already superseded it).
 * - window blur, pagehide and a hidden tab stop everything.
 * - `connect` again starts a fresh session; nothing held before is ever resumed (a new session
 *   starts zeroed on both ends). The rover takes one client, so there is no auto-reconnect: a stale
 *   tab reconnecting would steal the session from whoever is driving.
 */
export class HttpRoverClient extends BaseRoverClient {
  readonly kind = 'rover' as const
  readonly roverUrl: string
  private readonly fetch: FetchLike
  private token = 0
  private seq = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private polling = false
  private listening = false
  private readonly onHide = () => {
    if (typeof document === 'undefined' || document.hidden) this.stop()
  }
  private readonly onBlur = () => this.stop()

  constructor(roverUrl = DEFAULT_ROVER_URL, fetchImpl?: FetchLike) {
    super('rover')
    this.roverUrl = roverUrl
    this.fetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  }

  private url(endpoint: Endpoint) {
    return `${PROXY_BASE}/${endpoint}?rover=${encodeURIComponent(this.roverUrl)}`
  }

  private async request(endpoint: Endpoint, body?: URLSearchParams, keepalive = false): Promise<unknown> {
    const response = await this.fetch(this.url(endpoint), {
      method: body ? 'POST' : 'GET',
      ...(body ? { body } : {}),
      keepalive,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim()
      throw new Error(text ? `Rover HTTP ${response.status}: ${text.slice(0, 160)}` : `Rover HTTP ${response.status}`)
    }
    return response.json()
  }

  connect(): void {
    void this.open()
  }

  private async open() {
    this.endSession()
    this.update({ connection: 'connecting', lastError: null, motion: { ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 } })
    let token: number | null
    try {
      token = parseToken(await this.request('session', new URLSearchParams()))
      if (token === null) throw new Error('The rover answered /session without a token')
    } catch (err) {
      if (this.snapshot.connection !== 'connecting') return
      this.update({ connection: 'error', lastError: message(err) })
      return
    }
    if (this.snapshot.connection !== 'connecting') return
    this.token = token
    this.seq = 0
    this.update({ connection: 'connected', lastMessageAt: Date.now(), status: null })
    this.heartbeat = setInterval(() => {
      if (isMoving(this.snapshot.motion)) void this.send()
    }, HEARTBEAT_MS)
    this.poll = setInterval(() => void this.readStatus(), STATUS_POLL_MS)
    this.listen()
    void this.readStatus()
  }

  disconnect(): void {
    if (this.snapshot.connection === 'connected') {
      // One zero frame so the rover stops now rather than at the end of its lease.
      const token = this.token
      const seq = ++this.seq
      void this.request('control', encodeFrame({ token, seq, ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 }), true).catch(() => {})
    }
    this.endSession()
    this.update({ connection: 'disconnected', motion: { ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 }, status: null })
  }

  set(patch: Partial<MotionState>): void {
    if (patch.power !== undefined) percent(patch.power)
    if (patch.speed !== undefined) percent(patch.speed)
    this.update({ motion: { ...this.snapshot.motion, ...patch } })
    if (this.snapshot.connection === 'connected') void this.send()
  }

  stop(): void {
    this.update({ motion: { ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 } })
    if (this.snapshot.connection === 'connected') void this.send(true)
  }

  private async send(keepalive = false) {
    if (this.snapshot.connection !== 'connected' || !this.token) return
    if (this.seq >= MAX_SEQ - 1) {
      this.fail(new Error('Sequence numbers used up: connect again'))
      return
    }
    const token = this.token
    const seq = ++this.seq
    try {
      await this.request('control', encodeFrame({ token, seq, ...this.snapshot.motion }), keepalive)
      if (token === this.token) this.update({ lastMessageAt: Date.now() })
    } catch (err) {
      // A newer frame is already out (or a new session): this failure is history.
      if (seq !== this.seq || token !== this.token) return
      this.fail(err)
    }
  }

  /** Zero everything, one best-effort zero frame with a higher seq, and drop the session. */
  private fail(err: unknown) {
    const token = this.token
    const motion: MotionState = { ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 }
    if (token) void this.request('control', encodeFrame({ token, seq: ++this.seq, ...motion }), true).catch(() => {})
    this.endSession()
    // The last status report is from the lost session: nothing on it (ready, PWM, pan/lift) is current any more.
    this.update({ connection: 'error', motion, status: null, lastError: message(err) })
  }

  private async readStatus() {
    if (this.polling || this.snapshot.connection !== 'connected') return
    this.polling = true
    const token = this.token
    try {
      const status = parseStatus(await this.request('status'))
      if (token !== this.token) return
      if (!status) throw new Error('The rover answered /status with something unexpected')
      if (!status.ready) throw new Error('The rover reports a wheel PWM fault: disconnect the battery')
      this.update({ status, lastMessageAt: Date.now() })
    } catch (err) {
      if (token === this.token && this.snapshot.connection === 'connected') this.fail(err)
    } finally {
      this.polling = false
    }
  }

  private endSession() {
    this.token = 0
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    if (this.poll !== null) clearInterval(this.poll)
    this.heartbeat = this.poll = null
    this.unlisten()
  }

  private listen() {
    if (this.listening || typeof window === 'undefined') return
    this.listening = true
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('pagehide', this.onBlur)
    document.addEventListener('visibilitychange', this.onHide)
  }

  private unlisten() {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('pagehide', this.onBlur)
    document.removeEventListener('visibilitychange', this.onHide)
  }
}

function message(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return `No answer from the rover within ${REQUEST_TIMEOUT_MS} ms`
    return err.message
  }
  return String(err)
}
