import { Brain, DEFAULT_AUTOPILOT, RoverSim } from '@rover-brain'
import type { Pile, SimFrame, Vec3 } from '@rover-brain'
import { DEFAULT_SPEED, DEFAULT_WORLD, HARSH_SENSORS, PILE, VIEW, WORLDS } from './worlds'

/** The longest real-time gap one animation frame may advance (a background tab doesn't fast-forward). */
const MAX_DT_MS = 100
/** The pile's centre must be this far from a trunk or rock's edge, so the rover can reach it to empty the bin. */
const PILE_CLEARANCE_M = 0.45

/**
 * Owns the one RoverSim both views draw. It steps the sim in its own rAF loop (the views only read
 * `frame`), keeps the rover's trail, and bumps `version` whenever something a readout shows changes.
 */
export class SimController {
  sim!: RoverSim
  /** The latest frame (a copy: renderers may hold onto it). */
  frame!: SimFrame
  /** The frame before `frame`, for interpolating the rover between ticks. */
  prevFrame!: SimFrame
  trail: [number, number][] = []
  playing = true
  speed = DEFAULT_SPEED
  seed = 1
  noisy = false
  worldName = DEFAULT_WORLD
  /** Scoops that go into the bin before a trip to the pile: the brain's `capacity`. */
  capacity = DEFAULT_AUTOPILOT.capacity
  /** Where the user put the pile, overriding the yard's own; cleared when the yard changes. */
  pileOverride: Pile | null = null
  /** The next click on the ground (in either view) places the pile. */
  placingPile = false
  /** Bumped on every reset, so views can rebuild world geometry (obstacles). */
  resets = 0
  /** Bumped whenever the pile moves, so views can redraw it. */
  pileMoves = 0
  private version = 0
  private carry = 0
  private listeners = new Set<() => void>()
  private raf = 0
  private last = 0

  constructor() {
    this.reset()
  }

  reset() {
    const world = structuredClone(WORLDS[this.worldName] ?? WORLDS[DEFAULT_WORLD])
    if (this.pileOverride) world.pile = structuredClone(this.pileOverride)
    // The rover's own brain, as the phone runs it, with only the bin size changed.
    const brain = new Brain({ autopilot: { ...DEFAULT_AUTOPILOT, capacity: this.capacity } })
    this.sim = new RoverSim(world, { seed: this.seed || 1, ...(this.noisy ? HARSH_SENSORS : {}) }, brain)
    this.sim.start()
    this.frame = this.sim.frame()
    this.prevFrame = this.frame
    this.trail = []
    this.carry = 0
    this.resets += 1
    this.emit()
  }

  setWorld(name: string) {
    this.worldName = name
    this.pileOverride = null
    this.placingPile = false
    this.reset()
  }

  /** Changes the bin size on the running brain; a bin already that full heads for the pile. */
  setCapacity(capacity: number) {
    this.capacity = Math.max(1, Math.round(capacity))
    const brain = this.sim.brain
    brain.options.autopilot = { ...brain.options.autopilot, capacity: this.capacity }
    this.emit()
  }

  setPlacingPile(placing: boolean) {
    this.placingPile = placing
    this.emit()
  }

  /** Why the pile can't go at (x, z), or null if it can. */
  pileBlocked(x: number, z: number): string | null {
    const hit = (this.sim.world.obstacles ?? []).some((o) => Math.hypot(x - o.center[0], z - o.center[1]) < o.radiusM + PILE_CLEARANCE_M)
    return hit ? 'Too close to a trunk or rock' : null
  }

  /**
   * Moves the pile to (x, z) for the running sim and future restarts of this yard. Leaves already piled
   * at the old spot are back on the ground, so the rover fetches them too. Returns false if blocked.
   */
  setPile(x: number, z: number): boolean {
    const cx = clamp(x, VIEW.x0, VIEW.x1)
    const cz = clamp(z, VIEW.z0, VIEW.z1)
    if (this.pileBlocked(cx, cz)) return false
    this.pileOverride = { center: [cx, 0, cz], radiusM: PILE.radiusM }
    this.applyPile(this.pileOverride)
    return true
  }

  /** Puts the pile back where the yard has it. */
  resetPile() {
    this.pileOverride = null
    this.applyPile(structuredClone((WORLDS[this.worldName] ?? WORLDS[DEFAULT_WORLD]).pile ?? PILE))
  }

  private applyPile(pile: Pile) {
    this.placingPile = false
    this.sim.setPile(structuredClone(pile))
    this.frame = this.sim.frame()
    this.prevFrame = { ...this.prevFrame, leaves: this.frame.leaves, pile: this.frame.pile }
    this.pileMoves += 1
    this.emit()
  }

  setSeed(seed: number) {
    this.seed = Number.isFinite(seed) && seed !== 0 ? seed : 1
    this.reset()
  }

  setNoisy(noisy: boolean) {
    this.noisy = noisy
    this.reset()
  }

  setSpeed(speed: number) {
    this.speed = speed
    this.emit()
  }

  togglePlaying() {
    this.playing = !this.playing
    this.emit()
  }

  get done() {
    return isDone(this.frame)
  }

  /** How far (0–1) real time has got from `prevFrame` to `frame`, for smooth drawing. */
  get alpha() {
    if (!this.playing || this.done) return 1
    return Math.min(1, this.carry / this.sim.options.tickMs)
  }

  /** The camera's ground position [x, z] and yaw (degrees), blended between the last two ticks. */
  roverPose(): { x: number; z: number; yawDeg: number } {
    const a = this.prevFrame.rover
    const b = this.frame.rover
    const t = this.alpha
    return {
      x: a.position[0] + (b.position[0] - a.position[0]) * t,
      z: a.position[2] + (b.position[2] - a.position[2]) * t,
      yawDeg: lerpDeg(a.yawDeg, b.yawDeg, t),
    }
  }

  /** The reference viewer's loop: advance sim time by `dtMs × speed`, one tick at a time. Returns whether it stepped. */
  advance(dtMs: number): boolean {
    if (!this.playing || this.done) return false
    this.carry += Math.min(MAX_DT_MS, dtMs) * this.speed
    const tickMs = this.sim.options.tickMs
    let stepped = false
    while (this.carry >= tickMs) {
      this.carry -= tickMs
      this.prevFrame = this.frame
      this.frame = this.sim.step()
      this.trail.push([this.frame.rover.position[0], this.frame.rover.position[2]])
      stepped = true
      if (this.done) {
        this.carry = 0
        break
      }
    }
    return stepped
  }

  /**
   * Moves a leaf in the true world (what the simulated camera sees); the brain's belief is left alone, so
   * the rover only finds out when it next sees the leaf. Leaves in the scoop can't be moved.
   */
  moveLeaf(id: number, x: number, z: number): boolean {
    const i = this.sim.leaves.findIndex((l) => l.id === id)
    const leaf = this.sim.leaves[i]
    if (!leaf || leaf.where === 'scoop') return false
    const cx = clamp(x, VIEW.x0, VIEW.x1)
    const cz = clamp(z, VIEW.z0, VIEW.z1)
    leaf.position = [cx, 0, cz]
    this.sim.world.leaves[i] = [cx, cz]
    // Same rule as RoverSim's private classify(), so a paused view updates straight away.
    const pile = this.sim.world.pile
    leaf.where = pile && Math.hypot(cx - pile.center[0], cz - pile.center[2]) <= pile.radiusM ? 'pile' : 'ground'
    this.frame = this.sim.frame()
    this.prevFrame = { ...this.prevFrame, leaves: this.frame.leaves }
    this.emit()
    return true
  }

  /** The nearest movable leaf within `radiusM` of (x, z), or null. */
  leafAt(x: number, z: number, radiusM = 0.15): number | null {
    let best: number | null = null
    let bestD = radiusM
    for (const l of this.sim.leaves) {
      if (l.where === 'scoop') continue
      const d = Math.hypot(l.position[0] - x, l.position[2] - z)
      if (d <= bestD) {
        bestD = d
        best = l.id
      }
    }
    return best
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  startLoop() {
    if (this.raf) return
    this.last = performance.now()
    const loop = (now: number) => {
      const dt = now - this.last
      this.last = now
      if (this.advance(dt)) this.emit()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stopLoop() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private emit() {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}

export function isDone(frame: SimFrame) {
  return frame.stats.onGround === 0 && frame.stats.inScoop === 0
}

/** Where the rover is heading (the reference viewer's dashed goal line): the pile, the target leaf, or nowhere. */
export function goalOf(frame: SimFrame): Vec3 | null {
  const step = frame.tick.step
  if (!step) return null
  const target = step.state.targetId
  const goalLeaf = frame.tracked.find((t) => t.id === target)
  if (['returning', 'dumping'].includes(step.state.mode) && frame.pile) return frame.pile.center
  if (goalLeaf && ['approaching', 'aligning', 'scooping'].includes(step.state.mode)) return goalLeaf.world
  return null
}

/** Rover time as m:ss, as the reference viewer shows it. */
export function formatTime(ms: number) {
  return `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, '0')}`
}

/** The piled leaves' mound, copied from RoverSim's private moundPoints() so it matches what the LiDAR sees. */
export function moundSize(nPiled: number, pile: Pile) {
  return {
    heightM: Math.min(0.35, 0.006 * nPiled),
    radiusM: Math.min(pile.radiusM * 0.5, 0.1 + 0.015 * nPiled),
  }
}

/** The 2D view's world-metre → canvas-pixel mapping (the reference viewer's layout()). */
export type CanvasLayout = { scale: number; ox: number; oy: number }

export function canvasLayout(w: number, h: number): CanvasLayout {
  const scale = Math.min(w / (VIEW.x1 - VIEW.x0), h / (VIEW.z1 - VIEW.z0))
  return {
    scale,
    ox: (w - (VIEW.x1 - VIEW.x0) * scale) / 2 - VIEW.x0 * scale,
    oy: (h - (VIEW.z1 - VIEW.z0) * scale) / 2 - VIEW.z0 * scale,
  }
}

export const worldToCanvas = (l: CanvasLayout, x: number, z: number): [number, number] => [l.ox + x * l.scale, l.oy + z * l.scale]

export const canvasToWorld = (l: CanvasLayout, px: number, py: number): [number, number] => [(px - l.ox) / l.scale, (py - l.oy) / l.scale]

/** Linear blend of two angles in degrees, the short way round. */
export function lerpDeg(a: number, b: number, t: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180
  return a + d * t
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
