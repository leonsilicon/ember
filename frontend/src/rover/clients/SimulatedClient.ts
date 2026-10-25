import { ManualState } from '../manualControl'
import { HEARTBEAT_MS, isMoving, percent, type MotionState } from '../protocol'
import { BaseRoverClient } from './RoverClient'

const CONNECT_DELAY_MS = 400
const TICK_MS = 20

/**
 * In-browser stand-in for the rover. Runs the firmware's own control rules (ManualState, a port of
 * ManualControl.h): session and sequence checks, the 500 ms lease, servo jog integration, and the
 * PWM duties /status would report. Nothing here reflects hardware.
 */
export class SimulatedClient extends BaseRoverClient {
  readonly kind = 'simulated' as const
  private readonly firmware = new ManualState()
  private token = 0
  private seq = 0
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private lastDuties = ''
  private lastFrameAt = 0

  constructor() {
    super('simulated')
  }

  connect(): void {
    if (this.snapshot.connection === 'connected' || this.snapshot.connection === 'connecting') return
    this.update({ connection: 'connecting', lastError: null, motion: { ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 } })
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      this.token = Math.floor(Math.random() * 0x3fffffff) + 1
      this.seq = 0
      this.firmware.session(this.token, performance.now())
      this.update({ connection: 'connected', lastMessageAt: Date.now(), status: this.firmware.status() })
      this.ticker = setInterval(() => this.tick(), TICK_MS)
    }, CONNECT_DELAY_MS)
  }

  disconnect(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    if (this.ticker !== null) clearInterval(this.ticker)
    this.connectTimer = this.ticker = null
    this.firmware.stop()
    this.token = 0
    this.update({ connection: 'disconnected', motion: { ...this.snapshot.motion, wheel: 0, pan: 0, lift: 0 }, status: null })
  }

  set(patch: Partial<MotionState>): void {
    if (patch.power !== undefined) percent(patch.power)
    if (patch.speed !== undefined) percent(patch.speed)
    const motion = { ...this.snapshot.motion, ...patch }
    this.update({ motion })
    if (this.snapshot.connection !== 'connected') return
    this.frame(motion)
  }

  private frame(motion: MotionState) {
    this.lastFrameAt = performance.now()
    const accepted = this.firmware.accept(this.token, ++this.seq, motion.wheel, motion.pan, motion.lift, motion.power, motion.speed, this.lastFrameAt)
    this.update({ lastMessageAt: Date.now(), lastError: accepted ? null : 'Simulated rover refused the frame (409)', status: this.firmware.status() })
  }

  /** The firmware's loop (lease, servo travel) plus the client's heartbeat, and a status report whenever the outputs change. */
  private tick() {
    const now = performance.now()
    if (isMoving(this.snapshot.motion) && now - this.lastFrameAt >= HEARTBEAT_MS) this.frame(this.snapshot.motion)
    this.firmware.tick(now)
    const status = this.firmware.status()
    const key = `${status.pwm.join(',')}|${status.pan}|${status.lift}|${this.firmware.linked}`
    if (key === this.lastDuties) return
    this.lastDuties = key
    this.update({ status, lastMessageAt: Date.now() })
  }
}
