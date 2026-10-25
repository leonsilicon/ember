import type { ConnectionState } from '../clients/RoverClient'
import type { Tone } from '../ui/kit'

export const CONNECTION_STYLES: Record<ConnectionState, { tone: Tone; label: string }> = {
  disconnected: { tone: 'off', label: 'Disconnected' },
  connecting: { tone: 'warn', label: 'Connecting…' },
  connected: { tone: 'ok', label: 'Connected' },
  error: { tone: 'danger', label: 'Error' },
}
