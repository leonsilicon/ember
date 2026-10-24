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
      ctx.fillStyle = C.background
      ctx.fillRect(0, 0, w, h)

      // 1 m grid.
      ctx.strokeStyle = C.grid
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
      if (frame.pile && o.pileZone) {
        const c = frame.pile.center
        circle(c[0], c[2], frame.pile.radiusM, C.pileFill, C.pile, 1.5)
        ctx.fillStyle = C.pile
        ctx.font = '600 12px system-ui'
        ctx.textAlign = 'center'
        ctx.fillText('PILE', px(c[0]), py(c[2] + frame.pile.radiusM) - 8)
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
      for (const l of frame.leaves) {
        if (l.where === 'scoop') continue
        circle(l.position[0], l.position[2], 0.06, l.where === 'pile' ? C.leafPiled : C.leaf)
      }
      const target = frame.tick.step?.state.targetId
      if (o.belief) {
        for (const t of frame.tracked) {
          if (t.state === 'collected') continue
          const color = t.state === 'failed' ? C.blocked : t.state === 'tentative' ? C.muted : C.belief
          circle(t.world[0], t.world[2], t.id === target ? 0.16 : 0.11, undefined, color, t.id === target ? 2.5 : 1.25)
        }
      }

      // Rover: body round the axle, scoop in front, heading.
      const fwd = [Math.sin(yaw), -Math.cos(yaw)]
      const ax = cam[0] - fwd[0] * sim.options.axleBackM
      const az = cam[2] - fwd[1] * sim.options.axleBackM
      circle(ax, az, sim.options.bodyRadiusM, C.roverFill, C.rover, 2)
      const lip = sim.brain.options.autopilot.scoopLipM
      const half = sim.brain.options.autopilot.scoopWidthM / 2
      const right = [-fwd[1], fwd[0]]
      ctx.strokeStyle = frame.scoop === 'down' ? C.scoopDown : frame.scoop === 'dump' ? C.pile : C.rover
      ctx.lineWidth = frame.scoop === 'down' ? 5 : 3
      ctx.beginPath()
      ctx.moveTo(px(cam[0] + fwd[0] * lip - right[0] * half), py(cam[2] + fwd[1] * lip - right[1] * half))
      ctx.lineTo(px(cam[0] + fwd[0] * lip + right[0] * half), py(cam[2] + fwd[1] * lip + right[1] * half))
      ctx.stroke()
      if (frame.stats.inScoop > 0) circle(cam[0] + fwd[0] * 0.05, cam[2] + fwd[1] * 0.05, 0.06, C.leaf)
      circle(cam[0], cam[2], 0.035, C.rover)

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
      const id = controller.leafAt(x, z, Math.max(0.15, 10 / layout.scale))
      if (id == null) return
      dragging = id
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      const [x, z] = toWorld(e)
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

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [controller])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" aria-label="Top-down rover simulator view" />
}
