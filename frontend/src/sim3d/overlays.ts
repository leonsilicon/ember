import * as THREE from 'three'
import type { Corridor, SimFrame, Vec3 } from '@rover-brain'
import { PALETTE } from '../sim/overlays'

const noRaycast = (o: THREE.Object3D) => {
  o.raycast = () => {}
  return o
}

/** The rover's path so far, as one line that grows in place. */
export class TrailOverlay {
  readonly line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private capacity = 1024
  private drawn = 0

  constructor() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3))
    g.setDrawRange(0, 0)
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: PALETTE.belief, transparent: true, opacity: 0.7 }))
    this.line.frustumCulled = false
    noRaycast(this.line)
  }

  update(trail: [number, number][]) {
    if (trail.length < this.drawn) this.drawn = 0
    if (trail.length > this.capacity) {
      while (this.capacity < trail.length) this.capacity *= 2
      this.line.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3))
      this.drawn = 0
    }
    if (trail.length === this.drawn) return
    const attr = this.line.geometry.attributes.position as THREE.BufferAttribute
    for (let i = this.drawn; i < trail.length; i++) attr.setXYZ(i, trail[i][0], 0.012, trail[i][1])
    attr.needsUpdate = true
    this.drawn = trail.length
    this.line.geometry.setDrawRange(0, this.drawn)
  }
}

/** The camera's view on the ground (about ±27°, to 5 m), in the camera's frame (forward −z). */
export function makeFovWedge() {
  const pts = [0, 0, 0]
  for (let a = -27; a <= 27; a += 3) {
    const b = THREE.MathUtils.degToRad(a)
    pts.push(Math.sin(b) * 5, 0, -Math.cos(b) * 5)
  }
  const index: number[] = []
  for (let i = 1; i < pts.length / 3 - 1; i++) index.push(0, i + 1, i)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  g.setIndex(index)
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({ color: PALETTE.belief, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
  )
  mesh.position.y = 0.008
  mesh.renderOrder = 2
  return noRaycast(mesh) as THREE.Mesh
}

const OPEN = new THREE.Color('#4ade80')
const BLOCKED = new THREE.Color(PALETTE.blocked)

/** The brain's corridor fan from the camera, green where open and red where blocked, clamped to 2.5 m. */
export class CorridorOverlay {
  readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private max = 128

  constructor() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 6), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.max * 6), 3))
    g.setDrawRange(0, 0)
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }))
    this.lines.frustumCulled = false
    noRaycast(this.lines)
  }

  update(corridors: readonly Corridor[], camX: number, camZ: number, yawDeg: number) {
    const pos = this.lines.geometry.attributes.position as THREE.BufferAttribute
    const col = this.lines.geometry.attributes.color as THREE.BufferAttribute
    const n = Math.min(corridors.length, this.max)
    for (let i = 0; i < n; i++) {
      const c = corridors[i]
      const b = THREE.MathUtils.degToRad(yawDeg + c.bearingDeg)
      const d = Math.min(c.clearanceM, 2.5)
      const color = c.blockedBy ? BLOCKED : OPEN
      pos.setXYZ(i * 2, camX, 0.02, camZ)
      pos.setXYZ(i * 2 + 1, camX + Math.sin(b) * d, 0.02, camZ - Math.cos(b) * d)
      col.setXYZ(i * 2, color.r, color.g, color.b)
      col.setXYZ(i * 2 + 1, color.r, color.g, color.b)
    }
    pos.needsUpdate = true
    col.needsUpdate = true
    this.lines.geometry.setDrawRange(0, n * 2)
  }
}

/** What the brain believes: a ring per tracked leaf (bold for the target, grey unconfirmed, red failed). */
export class BeliefOverlay {
  readonly group = new THREE.Group()
  private thin = new THREE.RingGeometry(0.095, 0.115, 40)
  private bold = new THREE.RingGeometry(0.14, 0.175, 48)
  private mats = {
    confirmed: new THREE.MeshBasicMaterial({ color: PALETTE.belief, transparent: true, opacity: 0.9, depthWrite: false }),
    tentative: new THREE.MeshBasicMaterial({ color: PALETTE.muted, transparent: true, opacity: 0.9, depthWrite: false }),
    failed: new THREE.MeshBasicMaterial({ color: PALETTE.blocked, transparent: true, opacity: 0.9, depthWrite: false }),
  }
  private pool: THREE.Mesh[] = []

  update(frame: SimFrame) {
    const target = frame.tick.step?.state.targetId
    let used = 0
    for (const t of frame.tracked) {
      if (t.state === 'collected') continue
      let m = this.pool[used]
      if (!m) {
        m = noRaycast(new THREE.Mesh(this.thin, this.mats.confirmed)) as THREE.Mesh
        m.rotation.x = -Math.PI / 2
        m.renderOrder = 3
        this.pool.push(m)
        this.group.add(m)
      }
      m.visible = true
      m.geometry = t.id === target ? this.bold : this.thin
      m.material = t.state === 'failed' ? this.mats.failed : t.state === 'tentative' ? this.mats.tentative : this.mats.confirmed
      m.position.set(t.world[0], 0.03, t.world[2])
      used++
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].visible = false
  }

  dispose() {
    this.thin.dispose()
    this.bold.dispose()
    for (const m of Object.values(this.mats)) m.dispose()
  }
}

/** A dashed line from the camera to where the rover is heading. */
export class GoalOverlay {
  readonly line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>

  constructor() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    this.line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: PALETTE.belief, dashSize: 0.08, gapSize: 0.06 }))
    this.line.frustumCulled = false
    noRaycast(this.line)
  }

  update(goal: Vec3 | null, camX: number, camZ: number) {
    this.line.visible = goal != null
    if (!goal) return
    const pos = this.line.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, camX, 0.025, camZ)
    pos.setXYZ(1, goal[0], 0.025, goal[2])
    pos.needsUpdate = true
    this.line.computeLineDistances()
  }
}
