import type { ConnectionState } from '../clients/RoverClient'

export const CONNECTION_STYLES: Record<ConnectionState, { dot: string; label: string }> = {
  disconnected: { dot: 'bg-zinc-500', label: 'Disconnected' },
  connecting: { dot: 'bg-amber-400 animate-pulse', label: 'Connecting…' },
  connected: { dot: 'bg-emerald-400', label: 'Connected' },
  error: { dot: 'bg-red-500', label: 'Error' },
}
