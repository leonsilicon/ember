/**
 * Wire protocol of the rover's firmware, firmware/DualServoBench (V7, the sketch flashed on the
 * rover's ESP32).
 *
 * Plain HTTP on the rover's own Wi-Fi (ROVER_WIFI, DEFAULT_ROVER_URL), form-encoded bodies, no
 * CORS: the browser talks to its own origin's proxy at PROXY_BASE/<endpoint> (app/(rover)/api/rover),
 * which forwards to the rover.
 *
 *   POST /session                 -> {"token": n}   a new command session; the previous token stops
 *                                                    working and any motion is zeroed (servos keep holding)
 *   POST /control  (ControlFrame) -> {}             the FULL desired state, sent again every HEARTBEAT_MS
 *                                                    while anything is held; 400 malformed, 409 stale
 *                                                    token / old seq / out of range
 *   GET  /status                  -> StatusReport
 *
 * The firmware zeroes the wheels and the jogging LEASE_MS after the last accepted frame. There is no
 * stop endpoint: a stop is a new frame with wheel = pan = lift = 0. A 200 means accepted, not moved:
 * there is no encoder, current or angle feedback.
 */

export const ROVER_WIFI = { ssid: 'Leaf-Rover', password: 'leafrover' } as const
export const DEFAULT_ROVER_URL = 'http://192.168.4.1'
/** The same-origin proxy (app/(rover)/api/rover/[endpoint]/route.ts). */
export const PROXY_BASE = '/api/rover'
export const ENDPOINTS = { session: 'POST', control: 'POST', status: 'GET' } as const
export type Endpoint = keyof typeof ENDPOINTS

export const DIRECTIONS = ['forward', 'back', 'left', 'right'] as const
export type Direction = (typeof DIRECTIONS)[number]
/** The `wheel` field: 0 stop, 1 forward, 2 back, 3 pivot left, 4 pivot right. */
export type WheelCode = 0 | 1 | 2 | 3 | 4
export const WHEEL_CODE: Record<Direction, WheelCode> = { forward: 1, back: 2, left: 3, right: 4 }
const DIRECTION_OF: Record<WheelCode, Direction | null> = { 0: null, 1: 'forward', 2: 'back', 3: 'left', 4: 'right' }
export const directionOf = (code: WheelCode): Direction | null => DIRECTION_OF[code]

export const SERVOS = ['pan', 'lift'] as const
export type Servo = (typeof SERVOS)[number]
/** A servo's jog: -1 back, 0 stop jogging (it holds where it is), +1 forward. */
export type Jog = -1 | 0 | 1

/** What the rover is asked to do; the same five fields go in every frame. */
export interface MotionState {
  wheel: WheelCode
  pan: Jog
  lift: Jog
  /** Wheel PWM duty, 0..100 %. Not a measured speed. */
  power: number
  /** Servo jog rate, 0..100 %. 100 jumps straight to the endpoint; 0 disables position changes. */
  speed: number
}
export interface ControlFrame extends MotionState {
  token: number
  seq: number
}
export interface StatusReport {
  /** Wheel PWM initialised. Says nothing about hardware readiness or safety. */
  ready: boolean
  /** The last accepted frame's seq. */
  sequence: number
  /** Commanded pulse widths in µs (estimates, not measured angles). */
  pan: number
  lift: number
  /** Output duties 0..255 on GPIO 25, 26, 32, 33 (see PWM_PINS). */
  pwm: [number, number, number, number]
}

/** While anything is held the full state is re-sent this often. */
export const HEARTBEAT_MS = 100
/** The firmware zeroes wheels and jogging this long after the last accepted frame. */
export const LEASE_MS = 500
/** One request to the rover; longer than this counts as a failure (the client zeroes everything). */
export const REQUEST_TIMEOUT_MS = 900
/** How often the client reads /status while connected. */
export const STATUS_POLL_MS = 700
/** The firmware's own starting values. */
export const DEFAULT_POWER = 20
export const DEFAULT_SPEED = 10
/** Servo pulse bounds and the first-use estimate. Electrical bounds, not assembly-safe limits. */
export const SERVO_US = { min: 500, max: 2500, start: 1500 } as const
/** µs of travel per second at speed 1 %; the firmware steps `speed * 20 * dt / 1000` per tick. */
export const SERVO_US_PER_SECOND_PER_PERCENT = 20
/** Keep seq below this (the firmware parses it as a long). */
export const MAX_SEQ = 2147483647

export const STOPPED: Pick<MotionState, 'wheel' | 'pan' | 'lift'> = { wheel: 0, pan: 0, lift: 0 }
export const isMoving = (s: Pick<MotionState, 'wheel' | 'pan' | 'lift'>) => s.wheel !== 0 || s.pan !== 0 || s.lift !== 0

/** The four PWM outputs in /status order: what each pin drives. */
export const PWM_PINS = [
  { gpio: 25, label: 'L fwd' },
  { gpio: 26, label: 'L back' },
  { gpio: 32, label: 'R back' },
  { gpio: 33, label: 'R fwd' },
] as const

/** An integer percentage, or a thrown error: the firmware rejects anything else with 409. */
export function percent(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('Use an integer 0..100')
  return n
}

/** The frame as the firmware's form body, checked first: it answers 409 to anything out of range. */
export function encodeFrame(frame: ControlFrame): URLSearchParams {
  if (!Number.isInteger(frame.token) || frame.token <= 0) throw new Error('No session token')
  if (!Number.isInteger(frame.seq) || frame.seq <= 0 || frame.seq > MAX_SEQ) throw new Error('Sequence number out of range')
  if (!Number.isInteger(frame.wheel) || frame.wheel < 0 || frame.wheel > 4) throw new Error('Wheel code out of range')
  for (const jog of [frame.pan, frame.lift]) if (!Number.isInteger(jog) || jog < -1 || jog > 1) throw new Error('Jog out of range')
  percent(frame.power)
  percent(frame.speed)
  return new URLSearchParams({
    token: String(frame.token),
    seq: String(frame.seq),
    wheel: String(frame.wheel),
    pan: String(frame.pan),
    lift: String(frame.lift),
    power: String(frame.power),
    speed: String(frame.speed),
  })
}

export function parseToken(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const token = (data as { token?: unknown }).token
  return typeof token === 'number' && Number.isInteger(token) && token > 0 ? token : null
}

export function parseStatus(data: unknown): StatusReport | null {
  if (typeof data !== 'object' || data === null) return null
  const s = data as Record<string, unknown>
  const pwm = s.pwm
  if (typeof s.ready !== 'boolean' || typeof s.sequence !== 'number' || typeof s.pan !== 'number' || typeof s.lift !== 'number') return null
  if (!Array.isArray(pwm) || pwm.length !== 4 || !pwm.every((d) => typeof d === 'number')) return null
  return { ready: s.ready, sequence: s.sequence, pan: s.pan, lift: s.lift, pwm: [pwm[0], pwm[1], pwm[2], pwm[3]] }
}

/**
 * The direction the four duties add up to, as the firmware drives them: forward is GPIO 25 + 33,
 * back 26 + 32, a left pivot 26 + 33, a right pivot 25 + 32 (see ManualControl.h `targets`). Null
 * when the wheels are off or the pattern is none of those.
 */
export function reportedDirection(pwm: StatusReport['pwm']): Direction | null {
  const [lFwd, lBack, rBack, rFwd] = pwm
  const left = lFwd > 0 ? 1 : lBack > 0 ? -1 : 0
  const right = rFwd > 0 ? 1 : rBack > 0 ? -1 : 0
  if (left > 0 && right > 0) return 'forward'
  if (left < 0 && right < 0) return 'back'
  if (left < 0 && right > 0) return 'left'
  if (left > 0 && right < 0) return 'right'
  return null
}

/** The duties the firmware puts out for a motion state, in /status order (ManualControl.h `targets` + `duty`). */
export function dutiesFor(state: Pick<MotionState, 'wheel' | 'power'>): StatusReport['pwm'] {
  const p = Math.trunc((state.power * 255) / 100)
  // (left, right) in the firmware's own signs: the right side's positive pin is GPIO 32, which is physically back.
  const [left, right] = state.wheel === 1 ? [p, -p] : state.wheel === 2 ? [-p, p] : state.wheel === 3 ? [-p, -p] : state.wheel === 4 ? [p, p] : [0, 0]
  return [Math.max(left, 0), Math.max(-left, 0), Math.max(right, 0), Math.max(-right, 0)]
}
