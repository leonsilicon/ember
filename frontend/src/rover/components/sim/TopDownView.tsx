import { useEffect, useRef } from 'react'
import { canvasLayout, canvasToWorld, goalOf, type CanvasLayout, type SimController } from '../../sim/controller'
import { PALETTE as C, type Overlays } from '../../sim/overlays'
import { VIEW } from '../../sim/worlds'

type Props = { controller: SimController; overlays: Overlays }

/** The 2D reference viewer's top-down canvas, drawing the controller's sim. Drag a leaf to move it. */
export function TopDownView({ controller, overlays }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlaysRef = useRef(overlays)
  useEffect(() => {
    overlaysRef.current = overlays
  }, [overlays])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let layout: CanvasLayout = { scale: 1, ox: 0, oy: 0 }
    let dragging: number | null = null
    /** The pointer's world position while placing the pile, for the ghost ring. */
    let hover: [number, number] | null = null

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      layout = canvasLayout(w, h)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const px = (x: number) => layout.ox + x * layout.scale
    const py = (z: number) => layout.oy + z * layout.scale
    const circle = (x: number, z: number, r: number, fill?: string, stroke?: string, width = 1) => {
      ctx.beginPath()
      ctx.arc(px(x), py(z), r * layout.scale, 0, Math.PI * 2)
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

    const draw = () => {
      const o = overlaysRef.current
      const { sim, frame } = controller
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Ground, grid and rover follow the page's light/dark theme (the --map-* tokens in rover.css).
      const css = getComputedStyle(canvas)
      const T = {
        background: css.getPropertyValue('--map-bg').trim() || C.background,
        grid: css.getPropertyValue('--map-grid').trim() || C.grid,
        rover: css.getPropertyValue('--map-ink').trim() || C.rover,
        roverFill: css.getPropertyValue('--map-ink-fill').trim() || C.roverFill,
        muted: css.getPropertyValue('--map-muted').trim() || C.muted,
        work: css.getPropertyValue('--map-work').trim() || C.work,
      }
      ctx.fillStyle = T.background
      ctx.fillRect(0, 0, w, h)

      // 1 m grid.
      ctx.strokeStyle = T.grid
      ctx.lineWidth = 1
      for (let x = Math.ceil(VIEW.x0); x <= VIEW.x1; x++) {
        ctx.beginPath()
        ctx.moveTo(px(x), py(VIEW.z0))
        ctx.lineTo(px(x), py(VIEW.z1))
        ctx.stroke()
      }
      for (let z = Math.ceil(VIEW.z0); z <= VIEW.z1; z++) {
        ctx.beginPath()
        ctx.moveTo(px(VIEW.x0), py(z))
        ctx.lineTo(px(VIEW.x1), py(z))
        ctx.stroke()
      }

      // Pile.
      if (frame.pile) {
        const c = frame.pile.center
        // The work circle, labelled with its size where it crosses the top.
        if (Number.isFinite(frame.workRadiusM)) {
          ctx.setLineDash([7, 5])
          circle(c[0], c[2], frame.workRadiusM, undefined, T.work, 1.5)
          ctx.setLineDash([])
          const label = `${controller.workRadiusFt} ft`
          ctx.font = '600 11px ui-sans-serif, system-ui'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const lx = px(c[0])
          const ly = py(c[2] - frame.workRadiusM)
          const w = ctx.measureText(label).width + 10
          ctx.fillStyle = T.background
          ctx.fillRect(lx - w / 2, ly - 8, w, 16)
          ctx.fillStyle = T.work
          ctx.fillText(label, lx, ly)
          ctx.textBaseline = 'alphabetic'
        }
        circle(c[0], c[2], frame.pile.radiusM, o.pileZone ? C.pileFill : undefined, C.pile, 1.5)
        ctx.fillStyle = C.pile
        ctx.font = '600 11px ui-sans-serif, system-ui'
        ctx.textAlign = 'center'
        ctx.fillText('PILE', px(c[0]), py(c[2] + frame.pile.radiusM) - 6)
      }

      // Obstacles.
      for (const ob of sim.world.obstacles ?? []) circle(ob.center[0], ob.center[1], ob.radiusM, C.obstacle)

      // Path so far.
      if (o.trail) {
        ctx.strokeStyle = C.trail
        ctx.lineWidth = 1.5
        ctx.beginPath()
        controller.trail.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), py(z)) : ctx.moveTo(px(x), py(z))))
        ctx.stroke()
      }

      const pose = controller.roverPose()
      const yaw = (pose.yawDeg * Math.PI) / 180
      const cam = [pose.x, 0, pose.z]

      // Camera view (about ±27°, to 5 m) and the corridor fan.
      if (o.fov) {
        ctx.fillStyle = C.fov
        ctx.beginPath()
        ctx.moveTo(px(cam[0]), py(cam[2]))
        for (let a = -27; a <= 27; a += 3) {
          const b = yaw + (a * Math.PI) / 180
          ctx.lineTo(px(cam[0] + Math.sin(b) * 5), py(cam[2] - Math.cos(b) * 5))
        }
        ctx.closePath()
        ctx.fill()
      }
      if (o.corridors) {
        for (const c of frame.tick.corridors) {
          const b = yaw + (c.bearingDeg * Math.PI) / 180
          const d = Math.min(c.clearanceM, 2.5)
          ctx.strokeStyle = c.blockedBy ? C.blocked : C.open
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(px(cam[0]), py(cam[2]))
          ctx.lineTo(px(cam[0] + Math.sin(b) * d), py(cam[2] - Math.cos(b) * d))
          ctx.stroke()
        }
      }

      // True leaves (filled) and what the brain believes (rings).
      // Leaves outside the work circle are faded: the rover leaves them alone.
      const pile = frame.pile
      for (const l of frame.leaves) {
        if (l.where === 'scoop') continue
        const outside =
          l.where === 'ground' && pile != null && Math.hypot(l.position[0] - pile.center[0], l.position[2] - pile.center[2]) > frame.workRadiusM
        ctx.globalAlpha = outside ? 0.35 : 1
        circle(l.position[0], l.position[2], 0.06, l.where === 'pile' ? C.leafPiled : C.leaf)
        ctx.globalAlpha = 1
      }
      const target = frame.tick.step?.state.targetId
      if (o.belief) {
        for (const t of frame.tracked) {
          if (t.state === 'collected') continue
          const color = t.state === 'failed' ? C.blocked : t.state === 'tentative' ? T.muted : C.belief
          circle(t.world[0], t.world[2], t.id === target ? 0.16 : 0.11, undefined, color, t.id === target ? 2.5 : 1.25)
        }
      }

      // Rover: body round the axle, scoop in front, heading.
      const fwd = [Math.sin(yaw), -Math.cos(yaw)]
      const ax = cam[0] - fwd[0] * sim.options.axleBackM
      const az = cam[2] - fwd[1] * sim.options.axleBackM
      circle(ax, az, sim.options.bodyRadiusM, T.roverFill, T.rover, 2)
      const lip = sim.brain.options.autopilot.scoopLipM
      const half = sim.brain.options.autopilot.scoopWidthM / 2
      const right = [-fwd[1], fwd[0]]
      ctx.strokeStyle = frame.scoop === 'down' ? C.scoopDown : frame.scoop === 'dump' ? C.pile : T.rover
      ctx.lineWidth = frame.scoop === 'down' ? 5 : 3
      ctx.beginPath()
      ctx.moveTo(px(cam[0] + fwd[0] * lip - right[0] * half), py(cam[2] + fwd[1] * lip - right[1] * half))
      ctx.lineTo(px(cam[0] + fwd[0] * lip + right[0] * half), py(cam[2] + fwd[1] * lip + right[1] * half))
      ctx.stroke()
      if (frame.stats.inScoop > 0) circle(cam[0] + fwd[0] * 0.05, cam[2] + fwd[1] * 0.05, 0.06, C.leaf)
      circle(cam[0], cam[2], 0.035, T.rover)

      // Placing the pile: a ghost where it would go, red where it can't.
      if (controller.placingPile && hover) {
        const blocked = controller.pileBlocked(hover[0], hover[1]) != null
        ctx.setLineDash([6, 5])
        circle(hover[0], hover[1], frame.pile?.radiusM ?? 1, blocked ? 'rgba(248,113,113,.10)' : C.pileFill, blocked ? C.blocked : C.pile, 2)
        ctx.setLineDash([])
      }

      // Line to the current goal.
      const goal = goalOf(frame)
      if (goal) {
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = C.belief
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px(cam[0]), py(cam[2]))
        ctx.lineTo(px(goal[0]), py(goal[2]))
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    let raf = 0
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    // Leaf drag: grab the nearest leaf under the pointer, move it with the pointer (works while playing).
    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return canvasToWorld(layout, e.clientX - r.left, e.clientY - r.top)
    }
    const onDown = (e: PointerEvent) => {
      const [x, z] = toWorld(e)
      if (controller.placingPile) {
        controller.setPile(x, z)
        e.preventDefault()
        return
      }
      const id = controller.leafAt(x, z, Math.max(0.15, 10 / layout.scale))
      if (id == null) return
      dragging = id
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      const [x, z] = toWorld(e)
      hover = [x, z]
      if (controller.placingPile) {
        canvas.style.cursor = controller.pileBlocked(x, z) ? 'not-allowed' : 'crosshair'
        return
      }
      if (dragging != null) {
        if (!controller.moveLeaf(dragging, x, z)) dragging = null
        return
      }
      canvas.style.cursor = controller.leafAt(x, z, Math.max(0.15, 10 / layout.scale)) != null ? 'grab' : ''
    }
    const onUp = (e: PointerEvent) => {
      if (dragging == null) return
      dragging = null
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      canvas.style.cursor = 'grab'
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    const onLeave = () => (hover = null)
    canvas.addEventListener('pointerleave', onLeave)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
    }
  }, [controller])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" aria-label="Top-down rover simulator view" />
}
