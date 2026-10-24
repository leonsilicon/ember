import { AppNav } from './components/AppNav'
import { RoverSimulator } from './components/sim/RoverSimulator'

/** The autopilot simulator page (#/sim): the rover's real brain driving a virtual yard. */
export default function SimApp() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 lg:px-6">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Autopilot sim</h1>
          <p className="text-xs text-zinc-500">The rover's own brain, clearing a circle round the pile on a virtual lawn</p>
        </div>
        <AppNav current="/sim" />
      </header>
      <main className="min-h-0 flex-1">
        <RoverSimulator />
      </main>
    </div>
  )
}
