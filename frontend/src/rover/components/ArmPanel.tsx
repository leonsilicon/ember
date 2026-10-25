import type { ArmState } from '../protocol'
import { Button, Hint, Led, type Tone } from '../ui/kit'
import { Module } from '../ui/layout'

interface ArmPanelProps {
  arm: ArmState
  connected: boolean
  onRun: () => void
}

const ARM_TONE: Record<ArmState, Tone> = { idle: 'off', running: 'live', completed: 'ok', error: 'danger' }

export function ArmPanel({ arm, connected, onRun }: ArmPanelProps) {
  const running = arm === 'running'
  return (
    <Module
      id="arm"
      title="Arm"
      meta={
        <span className="inline-flex items-center gap-1.5 font-sans capitalize">
          <Led tone={ARM_TONE[arm]} blink={running} />
          {arm}
        </span>
      }
    >
      <Button size="lg" className="w-full" disabled={!connected || running} onClick={onRun}>
        {running ? 'Sequence running…' : 'Run arm sequence'}
      </Button>
      <Hint className="mt-2">Runs the one predefined sequence once. Ignored while it's running.</Hint>
    </Module>
  )
}
