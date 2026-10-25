import { useEffect, useState } from 'react'
import type { RoverSnapshot } from '../clients/RoverClient'
import type { Mode } from '../hooks/useRover'
import { DEFAULT_ROVER_URL, LEASE_MS, ROVER_WIFI } from '../protocol'
import { Button, Hint, INPUT, Led, Readout, Segmented } from '../ui/kit'
import { Module } from '../ui/layout'
import { CONNECTION_STYLES } from './connectionStyles'

interface ConnectionPanelProps {
  mode: Mode
  url: string
  snapshot: RoverSnapshot
  onSwitchMode: (mode: Mode) => void
  onConnect: (url?: string) => void
  onDisconnect: () => void
}

export const STALE_AFTER_MS = 3000

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function ConnectionPanel({ mode, url, snapshot, onSwitchMode, onConnect, onDisconnect }: ConnectionPanelProps) {
  const [draftUrl, setDraftUrl] = useState(url)
  const now = useNow(500)

  const { connection, lastMessageAt, lastError, status } = snapshot
  const connected = connection === 'connected'
  const ageMs = lastMessageAt === null ? null : Math.max(0, now - lastMessageAt)
  const stale = mode === 'live' && connected && ageMs !== null && ageMs > STALE_AFTER_MS
  const style = CONNECTION_STYLES[connection]

  return (
    <Module id="connection" title="Connection" meta={stale ? 'no heartbeat' : style.label}>
      <Segmented
        label="Source"
        options={['simulated', 'live'] as Mode[]}
        value={mode}
        onChange={onSwitchMode}
        render={(m) => (m === 'simulated' ? 'Simulated' : 'Live rover')}
        className="flex w-full"
      />

      {mode === 'live' ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onConnect(draftUrl.trim())
          }}
        >
          <label htmlFor="rover-url" className="sr-only">
            Rover address
          </label>
          <input
            id="rover-url"
            type="url"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder={DEFAULT_ROVER_URL}
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT} num flex-1`}
          />
          {connected || connection === 'connecting' ? (
            <Button key="disconnect" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button key="connect" type="submit" variant="primary" disabled={draftUrl.trim() === ''}>
              Connect
            </Button>
          )}
        </form>
      ) : (
        <Hint className="hatch mt-3 rounded-md border border-warn/40 px-3 py-2 text-ink-2">
          Simulated: everything below is generated in the browser. No hardware is involved.
        </Hint>
      )}

      {mode === 'live' && !connected && connection !== 'connecting' && (
        <Hint className="mt-2">
          Join the rover's Wi-Fi <span className="num text-ink">{ROVER_WIFI.ssid}</span> (password <span className="num text-ink">{ROVER_WIFI.password}</span>) on this laptop, then
          Connect. The rover takes one controller at a time; connecting here takes it over.
        </Hint>
      )}

      <dl className="mt-2">
        <Readout label="Status">
          <span className="inline-flex items-center gap-2 font-sans">
            <Led tone={stale ? 'warn' : style.tone} blink={connection === 'connecting'} />
            {style.label}
          </span>
        </Readout>
        {stale && (
          <Readout label="Heartbeat" tone="warn">
            none for {Math.round(ageMs! / 1000)}s
          </Readout>
        )}
        <Readout label="Last message">{ageMs === null ? '—' : `${(ageMs / 1000).toFixed(1)}s ago`}</Readout>
        {status && (
          <>
            <Readout label="Rover ready" tone={status.ready ? undefined : 'warn'}>
              {status.ready ? 'yes' : 'no (wheel PWM not initialised)'}
            </Readout>
            <Readout label="Frame">
              <span className="num">#{status.sequence}</span>
            </Readout>
            <Readout label="Wheel PWM">
              <span className="num" title="duty 0–255 on GPIO 25, 26, 32, 33">
                {status.pwm.join(' · ')}
              </span>
            </Readout>
          </>
        )}
        {lastError && (
          <Readout label="Last error" tone="danger">
            <span className="font-sans">{lastError}</span>
          </Readout>
        )}
      </dl>
      {mode === 'live' && (
        <Hint className="mt-2">
          Plain http through this site's own server (the rover has no CORS), so drive from the dev server on the laptop, not the site on Vercel. The rover stops
          anything held {LEASE_MS} ms after the last frame.
        </Hint>
      )}
    </Module>
  )
}
