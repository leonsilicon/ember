import { useEffect, useMemo, useRef, useState } from 'react'
import { ArmPanel } from './components/ArmPanel'
import { CapturePanel } from './components/CapturePanel'
import { ConnectionPanel } from './components/ConnectionPanel'
import { CONNECTION_STYLES } from './components/connectionStyles'
import { DPad } from './components/DPad'
import { LiveJobPanel } from './components/LiveJobPanel'
import { LiveMapView, type MapSource } from './components/LiveMapView'
import { PhoneCameraPanel, type PhoneLink } from './components/PhoneCameraPanel'
import { DEFAULT_SCENE, ScenePanel, type SceneSource } from './components/ScenePanel'
import { SplatViewer } from './components/SplatViewer'
import { StopButton } from './components/StopButton'
import { captureScene, useCaptures, viewable } from './hooks/useCaptures'
import { useLiveMap, type LiveMapStream } from './hooks/useLiveMap'
import { useRoomMap } from './hooks/useRoomMap'
import { useWebAutopilot } from './hooks/useWebAutopilot'
import { usePhoneDiscovery } from './hooks/usePhoneDiscovery'
import { applyJob, useLiveJob } from './liveJob'
import { useRover } from './hooks/useRover'
import { useAccount } from './ui/account'
import { Button, Hint, Icons, Led } from './ui/kit'
import { Module } from './ui/layout'
import { Shell, type Shortcut } from './ui/Shell'

const MODE_LABEL: Record<string, string> = {
  searching: 'looking',
  exploring: 'exploring',
  approaching: 'to a leaf',
  aligning: 'lining up',
  scooping: 'scooping',
  lifting: 'lifting',
  returning: 'to the pile',
  dumping: 'emptying',
  backing: 'backing off',
  checking: 'checking',
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['W', '↑'], label: 'Drive forward (hold)' },
  { keys: ['S', '↓'], label: 'Drive back (hold)' },
  { keys: ['A', '←'], label: 'Turn left (hold)' },
  { keys: ['D', '→'], label: 'Turn right (hold)' },
  { keys: ['Space', 'Esc'], label: 'Stop' },
]

/** The laptop remote (/control): drive and arm, the connection, the splat scene and the rover's camera. */
export default function App() {
  const rover = useRover()
  // The rover's iPhone, once its app is open on the same Wi-Fi: its camera links up by itself.
  const phones = usePhoneDiscovery()
  const [scene, setScene] = useState<SceneSource>(DEFAULT_SCENE)
  const captures = useCaptures()
  // The newest trained capture replaces the sample once the list arrives, unless a scene was picked first.
  const picked = useRef(false)
  const pickScene = (next: SceneSource) => {
    picked.current = true
    setScene(next)
  }
  useEffect(() => {
    if (picked.current || captures.state.kind !== 'ready') return
    const newest = captures.state.captures.find(viewable)
    if (!newest) return
    picked.current = true
    let cancelled = false
    void captureScene(newest).then((next) => {
      if (!cancelled) setScene(next)
    })
    return () => {
      cancelled = true
    }
  }, [captures.state])
  const { snapshot, mode } = rover
  // Live mode's stage: the brain's map from the phone, drawn in an instant (a splat takes ages to load). Over
  // the Wi-Fi from the linked phone; without one (the site on Vercel), through the server from the phone set
  // to this browser's username (see rooms.ts).
  const who = useAccount()
  const [phoneLink, setPhoneLink] = useState<PhoneLink | null>(null)
  const wifiMap = useLiveMap(mode === 'live' ? (phoneLink?.origin ?? null) : null)
  const roomMap = useRoomMap(mode === 'live' && !phoneLink)
  const liveMap: LiveMapStream = phoneLink ? wifiMap : roomMap
  const mapSource: MapSource | null = phoneLink ? { kind: 'wifi', phone: phoneLink.device } : who ? { kind: 'room', username: who } : null
  // The job set here (radius, bin, pile) on top of the phone's map: what the autopilot works to and the map draws.
  const [job, setJob] = useLiveJob()
  const [placingPile, setPlacingPile] = useState(false)
  const { map: phoneMap, receivedAt, trail, silent } = liveMap
  const jobMap = useMemo(() => ({ map: applyJob(phoneMap, job), receivedAt, trail, silent }), [phoneMap, receivedAt, trail, silent, job])
  const pilot = useWebAutopilot(rover, jobMap, mode === 'live')
  useEffect(() => {
    if (!placingPile) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPlacingPile(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placingPile])
  // A hand on the controls takes over from the autopilot (it stops it first).
  const pressByHand: typeof rover.press = (direction) => {
    if (pilot.on) pilot.stop('Stopped: driving by hand')
    rover.press(direction)
  }
  const stopByHand = () => {
    if (pilot.on) pilot.stop('Stopped by hand')
    rover.stop()
  }
  const connected = snapshot.connection === 'connected'
  const conn = CONNECTION_STYLES[snapshot.connection]

  return (
    <Shell
      page="/control"
      shortcuts={SHORTCUTS}
      status={
        <span className="hidden items-center gap-3 text-[13px] md:flex">
          <span className="flex items-center gap-2 text-ink">
            <Led tone={conn.tone} blink={snapshot.connection === 'connecting'} />
            {conn.label}
          </span>
          <span
            className={`rounded-[5px] px-2 py-0.5 text-[11px] font-semibold tracking-[0.12em] uppercase ${
              mode === 'simulated' ? 'hatch border border-warn/50 text-warn' : 'bg-ember-soft text-ember-ink'
            }`}
          >
            {mode === 'simulated' ? 'Simulated' : 'Live'}
          </span>
        </span>
      }
      actions={<StopButton compact disabled={!connected && !pilot.on} onStop={stopByHand} />}
      banner={
        mode === 'simulated' && (
          <div className="hatch mx-2 mb-2 flex items-center justify-between gap-3 rounded-[10px] border border-warn/40 py-1.5 pr-1.5 pl-3.5 lg:mx-2.5">
            <p className="text-[13px] text-ink">
              <span className="font-semibold">Simulated mode.</span> <span className="text-ink-2">No hardware connected; every reading is generated in the browser.</span>
            </p>
            <Button size="sm" onClick={() => rover.switchMode('live')}>
              Connect a rover
            </Button>
          </div>
        )
      }
      // A new key per scene: each one brings its own camera (the sample is -y up, captures +y up).
      stage={
        mode === 'live' ? (
          <LiveMapView
            stream={jobMap}
            source={mapSource}
            pilot={pilot}
            placing={placingPile}
            onPlace={(x, z) => {
              setJob((j) => ({ ...j, pile: { x, z } }))
              setPlacingPile(false)
            }}
          />
        ) : (
          <SplatViewer key={scene?.url ?? 'none'} source={scene?.url ?? null} label={scene?.label} format={scene?.format} camera={scene?.camera} />
        )
      }
      modules={
        <>
          <Module
            id="autopilot"
            title="Autopilot"
            meta={
              <span className="inline-flex items-center gap-1.5 font-sans">
                <Led tone={pilot.on ? 'live' : 'off'} blink={pilot.on && pilot.pressing == null} />
                {pilot.on ? `${pilot.dryRun ? 'dry run · ' : ''}${MODE_LABEL[pilot.mode ?? ''] ?? 'on'}` : 'off'}
              </span>
            }
          >
            {pilot.on ? (
              <Button size="lg" className="w-full" onClick={() => pilot.stop('Stopped')}>
                <Icons.square />
                Stop autopilot
              </Button>
            ) : (
              <Button size="lg" variant="primary" className="w-full" disabled={pilot.blocker != null} onClick={pilot.start}>
                <Icons.play />
                {connected ? 'Start autopilot' : 'Start dry run'}
              </Button>
            )}
            <dl className="mt-3">
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="text-[13px] text-ink-2">Doing</dt>
                <dd className="truncate text-right text-[13px] text-ink">{pilot.on ? pilot.message || '…' : (pilot.blocker ?? (pilot.message || 'Ready'))}</dd>
              </div>
              {pilot.on && (
                <div className="flex items-baseline justify-between gap-3 border-t border-line py-1.5">
                  <dt className="text-[13px] text-ink-2">Pressing</dt>
                  <dd className="num text-[13px] text-ink">{pilot.pressing ?? 'nothing'}</dd>
                </div>
              )}
            </dl>
            <Hint className="mt-2">
              Steers by the phone's live map with the rover's own autopilot and presses the drive buttons as you would. Any drive key, a D-pad button or Stop takes over.
              {!connected && ' With no rover connected it runs dry: the buttons are pressed on screen and nothing moves, so you can carry the phone and follow it.'}
            </Hint>
          </Module>

          {mode === 'live' && <LiveJobPanel job={job} onChange={setJob} map={phoneMap} placing={placingPile} onPlacing={setPlacingPile} />}

          <Module id="drive" title="Drive" meta={`${pilot.on ? 'autopilot' : 'rover'}: ${snapshot.drive}`}>
            <div className="flex flex-col items-center gap-3.5">
              <DPad
                held={pilot.on ? pilot.pressing : rover.held}
                reportedDrive={snapshot.drive}
                disabled={!connected && !pilot.on}
                onPress={pressByHand}
                onRelease={rover.release}
                auto={pilot.on}
              />
              <StopButton disabled={!connected && !pilot.on} onStop={stopByHand} />
            </div>
            <Hint className="mt-3">
              Hold a key or button to drive; let go to stop. Commands repeat every 100 ms, and the rover stops by itself after 300 ms of silence.
            </Hint>
          </Module>

          <ConnectionPanel
            mode={mode}
            url={rover.url}
            snapshot={snapshot}
            onSwitchMode={rover.switchMode}
            onConnect={rover.connect}
            onDisconnect={rover.disconnect}
          />

          <ArmPanel arm={snapshot.arm} connected={connected} onRun={rover.runArm} />

          {/* The iPhone riding on the rover, in live mode or as soon as its app is found on the Wi-Fi;
              otherwise the laptop webcam stand-in. */}
          {mode === 'live' || phones.length > 0 ? <PhoneCameraPanel phones={phones} onLink={setPhoneLink} /> : <CapturePanel />}

          {/* Scenes are for the simulated view; live mode's stage is the rover's map. */}
          {mode === 'simulated' && <ScenePanel scene={scene} onChange={pickScene} captures={captures.state} onRefresh={() => void captures.refresh()} />}
        </>
      }
    />
  )
}
