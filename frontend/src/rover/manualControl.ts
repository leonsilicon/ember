import { LEASE_MS, SERVO_US, SERVO_US_PER_SECOND_PER_PERCENT, type Jog, type MotionState, type StatusReport, type WheelCode } from './protocol'

/**
 * A line-for-line port of the firmware's Manual::State (firmware/DualServoBench/ManualControl.h):
 * the session and sequence rules, the lease, the servo jog integration and the wheel targets. The
 * simulated client runs it in the browser so Simulated mode behaves like the rover; the tests check
 * it against the firmware's own cases (tests/test_manual.cpp).
 */
export class ManualState {
  token = 0
  sequence = 0
  lastPacket = 0
  lastTick = 0
  wheel: WheelCode = 0
  pan: Jog = 0
  lift: Jog = 0
  wheelPower = 20
  servoSpeed = 10
  /** Commanded pulse widths, µs: pan then lift. */
  position: [number, number] = [SERVO_US.start, SERVO_US.start]
  /** Whether each servo has ever been jogged (and so holds a pulse). */
  enabled: [boolean, boolean] = [false, false]
  linked = false

  stop(): void {
    this.wheel = 0
    this.pan = 0
    this.lift = 0
    this.linked = false
  }

  session(key: number, now: number): void {
    this.stop()
    this.token = key
    this.sequence = 0
    this.lastPacket = this.lastTick = now
  }

  accept(key: number, seq: number, w: number, p: number, l: number, wp: number, sp: number, now: number): boolean {
    if (!key || key !== this.token || seq <= this.sequence) return false
    if (w < 0 || w > 4 || p < -1 || p > 1 || l < -1 || l > 1 || wp < 0 || wp > 100 || sp < 0 || sp > 100) return false
    if (![w, p, l, wp, sp, seq].every(Number.isInteger)) return false
    this.sequence = seq
    this.wheel = w as WheelCode
    this.pan = p as Jog
    this.lift = l as Jog
    this.wheelPower = wp
    this.servoSpeed = sp
    this.lastPacket = now
    this.linked = true
    return true
  }

  /** Call often (the firmware loops every ~2 ms; it integrates at most every 20 ms, in steps of at most 50 ms). */
  tick(now: number): void {
    if (this.linked && now - this.lastPacket >= LEASE_MS) this.stop()
    const elapsed = now - this.lastTick
    if (elapsed < 20) return
    this.lastTick = now
    const dt = elapsed > 50 ? 50 : elapsed
    const directions = [this.pan, this.lift]
    for (let i = 0; i < 2; i++) {
      const direction = directions[i]
      if (!this.linked || !direction || !this.servoSpeed) continue
      this.enabled[i] = true
      if (this.servoSpeed === 100) this.position[i] = direction > 0 ? SERVO_US.max : SERVO_US.min
      else {
        let step = Math.trunc((this.servoSpeed * SERVO_US_PER_SECOND_PER_PERCENT * dt) / 1000)
        if (step < 1) step = 1
        this.position[i] += direction * step
        if (this.position[i] < SERVO_US.min) this.position[i] = SERVO_US.min
        if (this.position[i] > SERVO_US.max) this.position[i] = SERVO_US.max
      }
    }
  }

  /** Signed wheel powers, in the firmware's own signs (the right side's positive pin is physically back). */
  targets(): [left: number, right: number] {
    if (!this.linked) return [0, 0]
    const p = this.wheelPower
    switch (this.wheel) {
      case 1:
        return [p, -p]
      case 2:
        return [-p, p]
      case 3:
        return [-p, -p]
      case 4:
        return [p, p]
      default:
        return [0, 0]
    }
  }

  /** The four output duties 0..255 in /status order (GPIO 25, 26, 32, 33). */
  duties(): StatusReport['pwm'] {
    const [left, right] = this.targets().map(duty)
    return [Math.max(left, 0), Math.max(-left, 0), Math.max(right, 0), Math.max(-right, 0)]
  }

  status(ready = true): StatusReport {
    return { ready, sequence: this.sequence, pan: this.position[0], lift: this.position[1], pwm: this.duties() }
  }

  motion(): MotionState {
    return { wheel: this.wheel, pan: this.pan, lift: this.lift, power: this.wheelPower, speed: this.servoSpeed }
  }
}

export const duty = (percent: number) => Math.trunc((percent * 255) / 100)
