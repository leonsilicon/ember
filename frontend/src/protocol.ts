/**
 * Wire protocol shared with firmware/rover_ws.
 *
 * Browser -> ESP32: {"cmd": "<Command>"}
 *   Drive commands are re-sent every DRIVE_REPEAT_MS while a direction is held.
 *   The firmware stops the motors if no drive command arrives for DRIVE_TIMEOUT_MS.
 *
 * ESP32 -> Browser: StatusMessage (after every command and every ~1s) or ErrorMessage.
 */

export const DRIVE_COMMANDS = ['forward', 'back', 'left', 'right', 'stop'] as const
export type DriveCommand = (typeof DRIVE_COMMANDS)[number]
export type Direction = Exclude<DriveCommand, 'stop'>
export type Command = DriveCommand | 'arm_run'

export const ARM_STATES = ['idle', 'running', 'completed', 'error'] as const
export type ArmState = (typeof ARM_STATES)[number]

export interface CommandMessage {
  cmd: Command
}

export interface StatusMessage {
  type: 'status'
  drive: DriveCommand
  arm: ArmState
  uptime_ms?: number
  clients?: number
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export type DeviceMessage = StatusMessage | ErrorMessage

/** How often a held direction is re-sent. Must be well under the firmware timeout. */
export const DRIVE_REPEAT_MS = 100
/** Firmware stops driving if no drive command arrives within this window. */
export const DRIVE_TIMEOUT_MS = 300
/** Duration of the simulated arm sequence. */
export const ARM_SEQUENCE_MS = 3000

export const DEFAULT_WS_URL = 'ws://192.168.4.1/ws'

export function isDriveCommand(value: unknown): value is DriveCommand {
  return typeof value === 'string' && (DRIVE_COMMANDS as readonly string[]).includes(value)
}

export function isArmState(value: unknown): value is ArmState {
  return typeof value === 'string' && (ARM_STATES as readonly string[]).includes(value)
}

export function parseDeviceMessage(raw: string): DeviceMessage | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>
  if (msg.type === 'status' && isDriveCommand(msg.drive) && isArmState(msg.arm)) {
    return {
      type: 'status',
      drive: msg.drive,
      arm: msg.arm,
      uptime_ms: typeof msg.uptime_ms === 'number' ? msg.uptime_ms : undefined,
      clients: typeof msg.clients === 'number' ? msg.clients : undefined,
    }
  }
  if (msg.type === 'error' && typeof msg.message === 'string') {
    return { type: 'error', message: msg.message }
  }
  return null
}
