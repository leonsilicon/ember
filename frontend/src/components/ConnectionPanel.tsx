import { useEffect, useState } from 'react'
import type { RoverSnapshot } from '../clients/RoverClient'
import type { Mode } from '../hooks/useRover'
import { CONNECTION_STYLES } from './connectionStyles'

interface ConnectionPanelProps {
  mode: Mode
  url: string
  snapshot: RoverSnapshot
  onSwitchMode: (mode: Mode) => void
  onConnect: (url?: string) => void
  onDisconnect: () => void
}

const STALE_AFTER_MS = 3000

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function ConnectionPanel({
  mode,
  url,
  snapshot,
  onSwitchMode,
  onConnect,
  onDisconnect,
}: ConnectionPanelProps) {
  const [draftUrl, setDraftUrl] = useState(url)
  const now = useNow(500)

  const { connection, lastMessageAt, lastError } = snapshot
  const connected = connection === 'connected'
  const ageMs = lastMessageAt === null ? null : now - lastMessageAt
  const stale = mode === 'live' && connected && ageMs !== null && ageMs > STALE_AFTER_MS

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Connection</h2>
        <div className="inline-flex rounded-lg border border-zinc-700 p-0.5 text-xs font-semibold">
          {(['simulated', 'live'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onSwitchMode(m)}
              aria-pressed={mode === m}
              className={[
                'rounded-md px-3 py-1 capitalize transition',
                mode === m
                  ? m === 'simulated'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'bg-sky-500 text-white'
                  : 'text-zinc-400 hover:text-zinc-100',
              ].join(' ')}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === 'live' ? (
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onConnect(draftUrl.trim())
          }}
        >
          <input
            type="text"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="ws://192.168.4.1/ws"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 focus:border-sky-400 focus:outline-none"
          />
          {connected || connection === 'connecting' ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="rounded-lg bg-zinc-700 px-3 py-2 text-sm font-semibold hover:bg-zinc-600"
            >
              Disconnect
            </button>
          ) : (
            <button
              type="submit"
              disabled={draftUrl.trim() === ''}
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              Connect
            </button>
          )}
        </form>
      ) : (
        <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Simulated: all status below is generated in the browser. No hardware is involved.
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-zinc-500">Status</dt>
        <dd className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${CONNECTION_STYLES[connection].dot}`} />
          {CONNECTION_STYLES[connection].label}
          {stale && <span className="text-xs text-amber-300">(no heartbeat for {Math.round(ageMs! / 1000)}s)</span>}
        </dd>
        <dt className="text-zinc-500">Source</dt>
        <dd className={mode === 'simulated' ? 'font-semibold text-amber-300' : 'font-semibold text-sky-300'}>
          {mode === 'simulated' ? 'SIMULATED' : 'DEVICE'}
        </dd>
        <dt className="text-zinc-500">Last message</dt>
        <dd className="text-zinc-300">{ageMs === null ? '—' : `${(ageMs / 1000).toFixed(1)}s ago`}</dd>
        {lastError && (
          <>
            <dt className="text-zinc-500">Last error</dt>
            <dd className="text-red-300">{lastError}</dd>
          </>
        )}
      </dl>
    </section>
  )
}
