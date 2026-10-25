import { useEffect, useRef, useState } from 'react'
import type { LiveMapStream } from '../hooks/useLiveMap'
import { PALETTE as C } from '../sim/overlays'
import { IconButton, Icons, Led, Meter } from '../ui/kit'

/** No map line for this long: the readout says so and the map dims. */
const STALE_MS = 2500
/** The camera's view on the map: about ±27°, drawn to 3 m. */
const FOV_DEG = 27
const FOV_M = 3
const ZOOMS = [0.6, 0.8, 1, 1.3, 1.7, 2.2, 3]

const MODE_LABEL: Record<string, string> = {
  searching: 'Looking for leaves',
  exploring: 'Exploring',
  approaching: 'Driving to a leaf',
  aligning: 'Lining up',
  scooping: 'Scooping',
  lifting: 'Into the bin',
  returning: 'To the pile',
  dumping: 'Emptying the bin',
  backing: 'Backing off',
  checking: 'Double-checking a spot',
}

/** The browser's autopilot, when it's the one driving. */
export type PilotView = {
  on: boolean
  mode: string | null
  message: string
  targetId: number | null
  load: number
  /** The button it's holding (null: hold still). */
  pressing: string | null
  dryRun: boolean
}

/** The button the autopilot holds, said as an instruction to whoever (or whatever) is driving. */
const INSTRUCTION: Record<string, { text: string; rotate: number | null }> = {
  forward: { text: 'Forward', rotate: 0 },
  back: { text: 'Back up', rotate: 180 },
  left: { text: 'Turn left', rotate: -90 },
  right: { text: 'Turn right', rotate: 90 },
}

type Props = {
  stream: LiveMapStream
  pilot?: PilotView
  /** Clicking the map puts the pile there (`onPlace`, AR-world floor x/z). */
  placing?: boolean
  onPlace?: (x: number, z: number) => void
  /** The linked phone, for the readout; null when no phone is linked. */
  phone: string | null
}

/**
 * The live rover's top view: what the brain on the phone believes, drawn as the simulator's map is
 * (rover, camera wedge, clear and blocked paths, tracked leaves, pile and work circle), from the map
 * lines the phone streams every steering tick. Fast where a splat is slow: it's a few hundred numbers.
 */
export function LiveMapView({ stream, phone, pilot, placing = false, onPlace }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef(stream)
  const [follow, setFollow] = useState(false)
  const [zoom, setZoom] = useState(2)
  const viewRef = useRef({ follow, zoom: ZOOMS[zoom] })
  const [now, setNow] = useState(0)

  const pilotRef = useRef(pilot)
  const placingRef = useRef(placing)
  const onPlaceRef = useRef(onPlace)
  useEffect(() => {
    streamRef.current = stream
    pilotRef.current = pilot
    placingRef.current = placing
    onPlaceRef.current = onPlace
  }, [stream, pilot, placing, onPlace])
  useEffect(() => {
    viewRef.current = { follow, zoom: ZOOMS[zoom] }
  }, [follow, zoom])

  // Freshness ticks over even when lines stop, so "stale" shows.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 500)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    // What's drawn eases toward the newest pose, so 5 updates a second still move smoothly.
    const shown = { x: 0, z: 0, yaw: 0, cx: 0, cz: 0, init: false }
    // The last frame's view, to turn a click into a floor position; and the pointer, for the pile's ghost.
    const view = { w: 1, h: 1, scale: 1 }
    let hover: [number, number] | null = null
    const toWorld = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [shown.cx + (e.clientX - r.left - view.w / 2) / view.scale, shown.cz + (e.clientY - r.top - view.h / 2) / view.scale]
    }
    const onMove = (e: PointerEvent) => {
      hover = toWorld(e)
      canvas.style.cursor = placingRef.current ? 'crosshair' : ''
    }
    const onLeave = () => (hover = null)
    const onDown = (e: PointerEvent) => {
      if (!placingRef.current) return
      e.preventDefault()
      const [x, z] = toWorld(e)
      onPlaceRef.current?.(Math.round(x * 100) / 100, Math.round(z * 100) / 100)
    }
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('pointerdown', onDown)
    let raf = 0
    let last = performance.now()

    const draw = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000)
      last = t
      const { map, trail, receivedAt } = streamRef.current
      const { follow: following, zoom: z } = viewRef.current
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const css = getComputedStyle(canvas)
      const T = {
        bg: css.getPropertyValue('--map-bg').trim() || C.background,
        grid: css.getPropertyValue('--map-grid').trim() || C.grid,
        ink: css.getPropertyValue('--map-ink').trim() || C.rover,
        inkFill: css.getPropertyValue('--map-ink-fill').trim() || C.roverFill,
        muted: css.getPropertyValue('--map-muted').trim() || C.muted,
        work: css.getPropertyValue('--map-work').trim() || C.work,
        font: css.getPropertyValue('--font-sans').trim() || 'system-ui',
      }

      const rover = map?.rover ?? null
      const pile = map?.pile ?? null
      if (rover) {
        if (!shown.init) Object.assign(shown, { x: rover.x, z: rover.z, yaw: rover.yawDeg, init: true })
        const k = 1 - Math.exp(-dt * 12)
        shown.x += (rover.x - shown.x) * k
        shown.z += (rover.z - shown.z) * k
        let dy = rover.yawDeg - shown.yaw
        dy = ((dy + 540) % 360) - 180
        shown.yaw += dy * k
      }
      // The view centres on the pile (the job), or follows the rover when asked or when there's no pile.
      const target = following || !pile ? (rover ? { x: shown.x, z: shown.z } : { x: 0, z: 0 }) : { x: pile.x, z: pile.z }
      const kc = 1 - Math.exp(-dt * 6)
      shown.cx += (target.x - shown.cx) * kc
      shown.cz += (target.z - shown.cz) * kc
      const span = Math.max(4, ((map?.workRadiusM ?? 1.8) * 2 + 1.5) / z)
      const scale = Math.min(w, h) / span
      Object.assign(view, { w, h, scale })
      const px = (x: number) => w / 2 + (x - shown.cx) * scale
      const py = (zz: number) => h / 2 + (zz - shown.cz) * scale

      ctx.fillStyle = T.bg
      ctx.fillRect(0, 0, w, h)

      // 1 m grid, on whole metres of the AR world.
      ctx.strokeStyle = T.grid
      ctx.lineWidth = 1
      const x0 = Math.floor(shown.cx - w / 2 / scale)
      const x1 = Math.ceil(shown.cx + w / 2 / scale)
      const z0 = Math.floor(shown.cz - h / 2 / scale)
      const z1 = Math.ceil(shown.cz + h / 2 / scale)
      ctx.beginPath()
      for (let x = x0; x <= x1; x++) {
        ctx.moveTo(Math.round(px(x)) + 0.5, 0)
        ctx.lineTo(Math.round(px(x)) + 0.5, h)
      }
      for (let zz = z0; zz <= z1; zz++) {
        ctx.moveTo(0, Math.round(py(zz)) + 0.5)
        ctx.lineTo(w, Math.round(py(zz)) + 0.5)
      }
      ctx.stroke()

      if (!map) {
        raf = requestAnimationFrame(draw)
        return
      }
      // Placing the pile: a ghost of it and its work circle under the pointer.
      if (placingRef.current && hover) {
        ctx.setLineDash([6, 5])
        ctx.strokeStyle = C.pile
        ctx.fillStyle = C.pileFill
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(px(hover[0]), py(hover[1]), (map.pile?.radiusM ?? 0.75) * scale, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.strokeStyle = T.work
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(px(hover[0]), py(hover[1]), map.workRadiusM * scale, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      const stale = receivedAt > 0 && performance.now() - receivedAt > STALE_MS
      ctx.globalAlpha = stale ? 0.45 : 1

      const ring = (x: number, zz: number, r: number, fill?: string, stroke?: string, width = 1) => {
        ctx.beginPath()
        ctx.arc(px(x), py(zz), r, 0, Math.PI * 2)
        if (fill) {
          ctx.fillStyle = fill
          ctx.fill()
        }
        if (stroke) {
          ctx.strokeStyle = stroke
          ctx.lineWidth = width
          ctx.stroke()
        }
      }

      // Pile and the work circle round it, labelled with its size where it crosses the top.
      if (pile) {
        ctx.setLineDash([8, 6])
        ring(pile.x, pile.z, map.workRadiusM * scale, undefined, T.work, 1.5)
        ctx.setLineDash([])
        const ft = Math.round(map.workRadiusM / 0.3048)
        const label = `${ft} ft`
        ctx.font = `600 12px ${T.font}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const lw = ctx.measureText(label).width + 10
        const ly = py(pile.z - map.workRadiusM)
        ctx.fillStyle = T.bg
        ctx.fillRect(px(pile.x) - lw / 2, ly - 9, lw, 18)
        ctx.fillStyle = T.work
        ctx.fillText(label, px(pile.x), ly)
        ring(pile.x, pile.z, pile.radiusM * scale, C.pileFill, C.pile, 1.5)
        ctx.fillStyle = C.pile
        ctx.textBaseline = 'alphabetic'
        ctx.fillText('PILE', px(pile.x), py(pile.z + pile.radiusM) - 8)
      }

      // The path so far.
      if (trail.length > 1) {
        ctx.strokeStyle = C.trail
        ctx.lineWidth = 1.5
        ctx.beginPath()
        trail.forEach(([x, zz], i) => (i ? ctx.lineTo(px(x), py(zz)) : ctx.moveTo(px(x), py(zz))))
        if (rover) ctx.lineTo(px(shown.x), py(shown.z))
        ctx.stroke()
      }

      const yaw = (shown.yaw * Math.PI) / 180
      const dir = (bearingDeg: number, d: number): [number, number] => {
        const b = yaw + (bearingDeg * Math.PI) / 180
        return [shown.x + Math.sin(b) * d, shown.z - Math.cos(b) * d]
      }

      if (rover) {
        // Camera wedge, then the brain's corridors: green to where it's clear, red where blocked.
        ctx.fillStyle = C.fov
        ctx.beginPath()
        ctx.moveTo(px(shown.x), py(shown.z))
        for (let a = -FOV_DEG; a <= FOV_DEG; a += 3) {
          const [x, zz] = dir(a, FOV_M)
          ctx.lineTo(px(x), py(zz))
        }
        ctx.closePath()
        ctx.fill()
        ctx.lineWidth = 2
        for (const c of map.corridors) {
          const [x, zz] = dir(c.bearingDeg, Math.min(c.clearanceM, 2.5))
          ctx.strokeStyle = c.blocked ? C.blocked : C.open
          ctx.beginPath()
          ctx.moveTo(px(shown.x), py(shown.z))
          ctx.lineTo(px(x), py(zz))
          ctx.stroke()
        }
      }

      // Leaves the brain has seen: confirmed filled, tentative as a faint ring, failed in red.
      const shownTarget = pilotRef.current?.on ? pilotRef.current.targetId : map.targetId
      for (const l of map.leaves) {
        const isTarget = l.id === shownTarget
        if (l.state === 'confirmed') ring(l.x, l.z, Math.max(3, 0.05 * scale), C.leaf)
        const color = l.state === 'failed' ? C.blocked : l.state === 'tentative' ? T.muted : C.belief
        ring(l.x, l.z, Math.max(isTarget ? 8 : 6, (isTarget ? 0.15 : 0.1) * scale), undefined, color, isTarget ? 2.5 : 1.25)
      }

      if (rover) {
        // Line to the target leaf.
        const targetId = pilotRef.current?.on ? pilotRef.current.targetId : map.targetId
        const target = map.leaves.find((l) => l.id === targetId)
        if (target) {
          ctx.setLineDash([4, 4])
          ctx.strokeStyle = C.belief
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(px(shown.x), py(shown.z))
          ctx.lineTo(px(target.x), py(target.z))
          ctx.stroke()
          ctx.setLineDash([])
        }
        // The rover: body, and a heading bar in front where the scoop is.
        const body = Math.max(9, 0.22 * scale)
        ring(shown.x, shown.z, body, T.inkFill, T.ink, 2)
        const [hx, hz] = dir(0, body / scale + 0.04)
        const [lx, lz] = dir(-90, 0.12)
        const [rx, rz] = dir(90, 0.12)
        ctx.strokeStyle = map.autopilot.mode === 'scooping' ? C.scoopDown : T.ink
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(px(hx + lx - shown.x), py(hz + lz - shown.z))
        ctx.lineTo(px(hx + rx - shown.x), py(hz + rz - shown.z))
        ctx.stroke()
        ring(shown.x, shown.z, 2.5, T.ink)
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
    }
  }, [])

  const { map: streamed, receivedAt, silent } = stream
  // While the browser drives, its autopilot is the one to show (the phone's own is off).
  const map = streamed && pilot?.on ? { ...streamed, autopilot: { on: true, mode: pilot.mode, message: pilot.message }, load: pilot.load, targetId: pilot.targetId } : streamed
  const age = receivedAt > 0 && now > 0 ? Math.max(0, now - receivedAt) : null
  const stale = age != null && age > STALE_MS
  const tracking = map?.rover != null
  const leaves = map?.leaves.filter((l) => l.state === 'confirmed').length ?? 0
  const headline = !map
    ? 'Waiting for the map'
    : stale
      ? 'Map not updating'
      : !tracking
        ? 'AR tracking lost'
        : map.autopilot.on
          ? (MODE_LABEL[map.autopilot.mode ?? ''] ?? 'Autopilot on')
          : 'Autopilot off'
  const tone = !map || stale ? 'warn' : !tracking ? 'danger' : map.autopilot.on ? 'live' : 'ok'
  const detail = !phone
    ? "Link the rover's iPhone in the Rover camera panel; its brain's map draws here."
    : silent && !map
      ? "The phone is linked but isn't sending its map. Update the rover app (TestFlight) to a build with the live map."
      : !map
        ? `Listening to ${phone}…`
        : stale
          ? `Last update ${(age! / 1000).toFixed(0)} s ago. Is the rover app's camera screen still open?`
          : (map.autopilot.message && map.autopilot.message !== headline ? map.autopilot.message : null) || (map.pile ? `${leaves} ${leaves === 1 ? 'leaf' : 'leaves'} seen in the circle` : 'No pile yet: set it on the phone to start a job')

  return (
    <section aria-label="Live top view" className="absolute inset-0">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Top view of the rover, the leaves it has seen and the pile" />

      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute top-3 left-3 w-[min(320px,calc(100%-5.5rem))] rounded-[10px] border border-line bg-panel/95 px-3.5 py-3 shadow-float backdrop-blur-sm"
      >
        <div className="flex items-center gap-2">
          <Led tone={tone} blink={!map && phone != null} />
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{headline}</span>
          <span className="num ml-auto pl-3 text-xs text-ink-3">{map && !stale ? 'live' : '—'}</span>
        </div>
        <p className="mt-0.5 text-xs leading-snug text-ink-2">{detail}</p>
        {map && (
          <div className="mt-3 grid gap-2">
            <Meter count={map.capacity} filled={map.load} color="var(--ok)" label={`bin ${Math.min(map.load, map.capacity)}/${map.capacity}`} />
            <p className="num text-[11px] text-ink-3">
              {leaves} in view · {map.dumped} emptied on the pile
            </p>
          </div>
        )}
      </div>

      <div className="absolute top-3 right-3 flex flex-col gap-0.5 rounded-[10px] border border-line bg-panel/95 p-1 shadow-float backdrop-blur-sm" role="toolbar" aria-label="Map view" aria-orientation="vertical">
        <IconButton label="Follow the rover" pressed={follow} onClick={() => setFollow((f) => !f)}>
          <Icons.follow />
        </IconButton>
        <IconButton label="Zoom in" onClick={() => setZoom((i) => Math.min(ZOOMS.length - 1, i + 1))} disabled={zoom >= ZOOMS.length - 1}>
          <Icons.plus />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => setZoom((i) => Math.max(0, i - 1))} disabled={zoom <= 0}>
          <Icons.minus />
        </IconButton>
      </div>
      {pilot?.on && (
        <div
          aria-live="assertive"
          className="pointer-events-none absolute inset-x-3 bottom-12 mx-auto flex w-fit max-w-full items-center gap-3 rounded-2xl border border-line bg-panel/95 py-2.5 pr-5 pl-3 shadow-float backdrop-blur-sm"
        >
          <span
            className={`grid h-11 w-11 place-items-center rounded-xl ${pilot.pressing ? 'bg-ink text-panel' : 'bg-danger text-white'}`}
            style={pilot.pressing && INSTRUCTION[pilot.pressing]?.rotate != null ? { transform: `rotate(${INSTRUCTION[pilot.pressing].rotate}deg)` } : undefined}
          >
            {pilot.pressing ? <Icons.arrow /> : <span className="h-3.5 w-3.5 rounded-[3px] bg-white" />}
          </span>
          <span>
            <span className="block text-xl font-semibold tracking-[-0.01em] text-ink">{pilot.pressing ? (INSTRUCTION[pilot.pressing]?.text ?? pilot.pressing) : 'Hold still'}</span>
            <span className="block text-[11px] tracking-[0.12em] text-ink-3 uppercase">{pilot.dryRun ? 'Dry run · rover not connected' : 'Autopilot driving'}</span>
          </span>
        </div>
      )}
      {placing && (
        <p className={`pointer-events-none absolute inset-x-3 mx-auto w-fit max-w-full rounded-full border border-ember bg-panel px-3.5 py-1.5 text-center text-xs font-medium text-ink shadow-float ${pilot?.on ? 'bottom-[7.25rem]' : 'bottom-12'}`}>
          Click the map to put the pile there. <span className="text-ink-3">Esc cancels.</span>
        </p>
      )}
      <p className="pointer-events-none absolute right-3 bottom-3 rounded-md bg-panel/90 px-2 py-0.5 text-[11px] text-ink-2">1 m grid</p>
    </section>
  )
}
