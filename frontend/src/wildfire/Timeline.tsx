import { Button, Slider } from '@blueprintjs/core'
import { Pause, Play, Reset } from '@blueprintjs/icons'
import { fmtClock } from './format'
import { HORIZON_MIN, ISOCHRONES } from './sim/useSimulation'


interface Props {
  t: number
  playing: boolean
  speed: number
  burnedHa: number
  ignited: number
  ignitedTotal: number
  onPlay: (p: boolean) => void
  onScrub: (t: number) => void
  onSpeed: (s: number) => void
}

export function Timeline({ t, playing, speed, burnedHa, ignited, ignitedTotal, onPlay, onScrub, onSpeed }: Props) {
  return (
    <div className="panel rise pointer-events-auto flex items-center gap-4 px-4 py-2">
      <div className="flex items-center gap-1">
        <Button small minimal intent="primary" icon={playing ? <Pause /> : <Play />} onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'} />
        <Button small minimal icon={<Reset />} onClick={() => { onPlay(false); onScrub(0) }} aria-label="Restart" />
      </div>
      <div className="mono w-[76px] text-lg leading-none" style={{ color: 'var(--ops-cyan)' }}>{fmtClock(t)}</div>
      <div className="relative flex-1 px-1">
        <div className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 justify-between">
          {ISOCHRONES.map((m) => (
            <span key={m} className="label absolute -top-4" style={{ left: `${(m / HORIZON_MIN) * 100}%`, transform: 'translateX(-50%)' }}>
              {m / 60}h
            </span>
          ))}
        </div>
        <Slider min={0} max={HORIZON_MIN} stepSize={1} labelRenderer={false} value={Math.min(t, HORIZON_MIN)} onChange={onScrub} />
      </div>
      <div className="flex gap-1">
        {[5, 15, 60].map((s) => (
          <Button key={s} small minimal={speed !== s} active={speed === s} className="mono" onClick={() => onSpeed(s)}>{s}×</Button>
        ))}
      </div>
      <div className="hidden items-center gap-5 md:flex">
        <Stat label="Burned" value={`${Math.round(burnedHa).toLocaleString()} ha`} />
        <Stat label="Homes ignited" value={`${ignited} / ${ignitedTotal}`} tone={ignited ? 'var(--ops-red)' : undefined} />
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="text-right">
      <div className="label">{label}</div>
      <div className="mono text-sm" style={{ color: tone }}>{value}</div>
    </div>
  )
}
