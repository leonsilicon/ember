import { ArmPanel } from './components/ArmPanel'
import { ConnectionPanel } from './components/ConnectionPanel'
import { CONNECTION_STYLES } from './components/connectionStyles'
import { DPad } from './components/DPad'
import { StopButton } from './components/StopButton'
import { CapturePanel } from './components/CapturePanel'
import { ScenePanel, type SceneSource } from './components/ScenePanel'
import { SplatViewer } from './components/SplatViewer'
import { useRover } from './hooks/useRover'
import { useState } from 'react'

export default function App() {
  const rover = useRover()
  const [scene, setScene] = useState<SceneSource>(null)
  const { snapshot, mode } = rover
  const connected = snapshot.connection === 'connected'

  return (
    <div className="flex min-h-full flex-col">
      {mode === 'simulated' && (
        <div className="bg-amber-500 px-4 py-1 text-center text-xs font-bold tracking-widest text-zinc-950 uppercase">
          Simulated mode — no hardware connected
        </div>
      )}
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Rover Control</h1>
          <p className="text-xs text-zinc-500">soon2026 · laptop remote for rover + arm</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${CONNECTION_STYLES[snapshot.connection].dot}`} />
            {CONNECTION_STYLES[snapshot.connection].label}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
              mode === 'simulated' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'
            }`}
          >
            {mode === 'simulated' ? 'SIMULATED' : 'LIVE'}
          </span>
        </div>
      </header>

      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[1fr_380px] lg:p-6">
        <div className="flex min-h-[420px] flex-col gap-4">
          <SplatViewer source={scene?.url ?? null} label={scene?.label} />
          <div className="grid gap-4 md:grid-cols-2">
            <ScenePanel scene={scene} onChange={setScene} />
            <CapturePanel />
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <ConnectionPanel
            mode={mode}
            url={rover.url}
            snapshot={snapshot}
            onSwitchMode={rover.switchMode}
            onConnect={rover.connect}
            onDisconnect={rover.disconnect}
          />

          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Drive</h2>
              <span className="text-xs text-zinc-500">
                {mode === 'simulated' ? 'simulated' : 'device'} reports:{' '}
                <span className="font-mono text-zinc-200">{snapshot.drive}</span>
              </span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <DPad
                held={rover.held}
                reportedDrive={snapshot.drive}
                disabled={!connected}
                onPress={rover.press}
                onRelease={rover.release}
              />
              <StopButton disabled={!connected} onStop={rover.stop} />
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Hold a button or WASD / arrow key to drive; release to stop. Commands repeat every 100 ms and the
              firmware stops on its own after 300 ms of silence.
            </p>
          </section>

          <ArmPanel arm={snapshot.arm} connected={connected} onRun={rover.runArm} />
        </aside>
      </main>
    </div>
  )
}
