import { useEffect, useRef, useState } from 'react'
import { ArmPanel } from './components/ArmPanel'
import { CapturePanel } from './components/CapturePanel'
import { ConnectionPanel } from './components/ConnectionPanel'
import { CONNECTION_STYLES } from './components/connectionStyles'
import { DPad } from './components/DPad'
import { PhoneCameraPanel } from './components/PhoneCameraPanel'
import { DEFAULT_SCENE, ScenePanel, type SceneSource } from './components/ScenePanel'
import { SplatViewer } from './components/SplatViewer'
import { StopButton } from './components/StopButton'
import { captureScene, useCaptures, viewable } from './hooks/useCaptures'
import { usePhoneDiscovery } from './hooks/usePhoneDiscovery'
import { useRover } from './hooks/useRover'
import { Button, Hint, Led } from './ui/kit'
import { Module } from './ui/layout'
import { Shell, type Shortcut } from './ui/Shell'

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
      actions={<StopButton compact disabled={!connected} onStop={rover.stop} />}
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
      stage={<SplatViewer key={scene?.url ?? 'none'} source={scene?.url ?? null} label={scene?.label} format={scene?.format} camera={scene?.camera} />}
      modules={
        <>
          <Module id="drive" title="Drive" meta={`rover: ${snapshot.drive}`}>
            <div className="flex flex-col items-center gap-3.5">
              <DPad held={rover.held} reportedDrive={snapshot.drive} disabled={!connected} onPress={rover.press} onRelease={rover.release} />
              <StopButton disabled={!connected} onStop={rover.stop} />
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
          {mode === 'live' || phones.length > 0 ? <PhoneCameraPanel phones={phones} /> : <CapturePanel />}

          <ScenePanel scene={scene} onChange={pickScene} captures={captures.state} onRefresh={() => void captures.refresh()} />
        </>
      }
    />
  )
}
