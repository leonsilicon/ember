import { ARM_SEQUENCE_MS, DRIVE_TIMEOUT_MS, isDriveCommand, type Command } from '../protocol'
import { BaseRoverClient } from './RoverClient'

const CONNECT_DELAY_MS = 400

/**
 * In-browser stand-in for the ESP32. Mirrors the firmware rules:
 * - drive stops if no drive command arrives within DRIVE_TIMEOUT_MS
 * - arm_run is rejected while the sequence is running
 * - the sequence "completes" after ARM_SEQUENCE_MS
 */
export class SimulatedClient extends BaseRoverClient {
  readonly kind = 'simulated' as const
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private armTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super('simulated')
  }

  connect(): void {
    if (this.snapshot.connection === 'connected' || this.snapshot.connection === 'connecting') return
    this.update({ connection: 'connecting', lastError: null })
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      this.update({ connection: 'connected', lastMessageAt: Date.now() })
    }, CONNECT_DELAY_MS)
  }

  disconnect(): void {
    this.clearTimer('connectTimer')
    this.clearTimer('watchdogTimer')
    this.clearTimer('armTimer')
    this.update({ connection: 'disconnected', drive: 'stop', arm: 'idle' })
  }

  send(cmd: Command): void {
    if (this.snapshot.connection !== 'connected') {
      this.update({ lastError: 'Not connected' })
      return
    }

    if (isDriveCommand(cmd)) {
      this.clearTimer('watchdogTimer')
      if (cmd !== 'stop') {
        this.watchdogTimer = setTimeout(() => {
          this.watchdogTimer = null
          this.update({ drive: 'stop', lastMessageAt: Date.now() })
        }, DRIVE_TIMEOUT_MS)
      }
      this.update({ drive: cmd, lastMessageAt: Date.now(), lastError: null })
      return
    }

    if (cmd === 'arm_run') {
      if (this.snapshot.arm === 'running') {
        this.update({ lastError: 'arm busy', lastMessageAt: Date.now() })
        return
      }
      this.update({ arm: 'running', lastMessageAt: Date.now(), lastError: null })
      this.armTimer = setTimeout(() => {
        this.armTimer = null
        this.update({ arm: 'completed', lastMessageAt: Date.now() })
      }, ARM_SEQUENCE_MS)
    }
  }

  private clearTimer(name: 'connectTimer' | 'watchdogTimer' | 'armTimer'): void {
    const timer = this[name]
    if (timer !== null) {
      clearTimeout(timer)
      this[name] = null
    }
  }
}
