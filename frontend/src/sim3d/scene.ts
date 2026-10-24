import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { goalOf, type SimController } from '../sim/controller'
import type { Overlays } from '../sim/overlays'
import { DEFAULT_OVERLAYS } from '../sim/overlays'
import { VIEW } from '../sim/worlds'
import { ProceduralGround, type GroundLayer } from './ground'
import { LeafInstances } from './leaves'
import { buildObstacles } from './obstacles'
import { BeliefOverlay, CorridorOverlay, GoalOverlay, makeFovWedge, TrailOverlay } from './overlays'
import { PileModel } from './pile'
import { RoverModel } from './rover'

const SKY = '#a9c3dd'
const VIEW_CENTER_Z = (VIEW.z0 + VIEW.z1) / 2
/** Behind and above the start, looking out over the yard. */
const HOME_POSITION = new THREE.Vector3(0, 2.6, 3.1)
const HOME_TARGET = new THREE.Vector3(0, 0, -1.4)

/**
 * The 3D view of a SimController's sim. It never steps the sim: each animation frame it reads
 * `controller.frame` (and the interpolated rover pose) and updates the scene to match. Leaves can be
 * dragged across the ground. `dispose()` frees everything, including the WebGL context.
 */
export class SimScene3D {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(50, 1, 0.03, 80)
  private controls: OrbitControls
  private ground: GroundLayer | null = null
  private world = new THREE.Group()
  private obstacles: THREE.Group | null = null
  private leaves: LeafInstances | null = null
  private pile = new PileModel()
  private rover: RoverModel | null = null
  private trail = new TrailOverlay()
  private fov = makeFovWedge()
  private corridors = new CorridorOverlay()
  private belief = new BeliefOverlay()
  private goal = new GoalOverlay()
  private overlays: Overlays = DEFAULT_OVERLAYS
  private follow = false
  private resets = -1
  private raf = 0
  private lastMs = performance.now()
  private observer: ResizeObserver
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private dragging: number | null = null
  private tmp = new THREE.Vector3()
  private container: HTMLElement
  private controller: SimController

  constructor(container: HTMLElement, controller: SimController) {
    this.container = container
    this.controller = controller
    const r = new THREE.WebGLRenderer({ antialias: true })
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.toneMappingExposure = 1.05
    r.outputColorSpace = THREE.SRGBColorSpace
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFShadowMap
    r.domElement.style.display = 'block'
    r.domElement.style.width = '100%'
    r.domElement.style.height = '100%'
    r.domElement.style.touchAction = 'none'
    container.appendChild(r.domElement)
    this.renderer = r

    this.scene.background = new THREE.Color(SKY)
    this.scene.fog = new THREE.Fog(SKY, 10, 24)
    const hemi = new THREE.HemisphereLight('#cfe3ff', '#4a5a2a', 1.4)
    const sun = new THREE.DirectionalLight('#fff1d6', 2.6)
    sun.position.set(3.5, 7, 2.5)
    sun.target.position.set(0, 0, VIEW_CENTER_Z)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = 0.02
    Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 20 })
    this.scene.add(hemi, sun, sun.target, this.world)

    this.setGroundLayer(new ProceduralGround(r.capabilities.getMaxAnisotropy()))
    this.world.add(this.pile.zone, this.pile.mound, this.trail.line, this.fov, this.corridors.lines, this.belief.group, this.goal.line)

    // Leaf drag listeners go on before OrbitControls', so a press on a leaf can stop the orbit.
    const el = r.domElement
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointercancel', this.onUp)
    this.controls = new OrbitControls(this.camera, el)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.06
    this.controls.minDistance = 0.4
    this.controls.maxDistance = 14
    this.resetView()

    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(container)
    this.resize()
    this.raf = requestAnimationFrame(this.loop)
  }

  /** Swaps what the rover drives on (the procedural lawn now; a Gaussian splat later). */
  setGroundLayer(layer: GroundLayer) {
    this.ground?.dispose()
    this.ground = layer
    layer.setLitterVisible?.(this.overlays.litter)
    this.scene.add(layer.object)
  }

  setOverlays(o: Overlays) {
    this.overlays = o
    this.trail.line.visible = o.trail
    this.fov.visible = o.fov
    this.corridors.lines.visible = o.corridors
    this.belief.group.visible = o.belief
    this.pile.zone.visible = o.pileZone && this.controller.frame.pile != null
    this.ground?.setLitterVisible?.(o.litter)
  }

  setFollow(follow: boolean) {
    this.follow = follow
  }

  resetView() {
    this.camera.position.copy(HOME_POSITION)
    this.controls.target.copy(HOME_TARGET)
    this.controls.update()
  }

  /** Straight down with −z up the screen, matching the 2D view. */
  topDown() {
    this.camera.position.set(0, 9.5, VIEW_CENTER_Z + 0.01)
    this.controls.target.set(0, 0, VIEW_CENTER_Z)
    this.controls.update()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onDown)
    el.removeEventListener('pointermove', this.onMove)
    el.removeEventListener('pointerup', this.onUp)
    el.removeEventListener('pointercancel', this.onUp)
    this.controls.dispose()
    this.ground?.dispose()
    this.leaves?.dispose()
    this.belief.dispose()
    const textures = new Set<THREE.Texture>()
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) textures.add(v)
        mat.dispose()
      }
      if (o instanceof THREE.InstancedMesh) o.dispose()
    })
    for (const t of textures) t.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    el.remove()
  }

  /** Rebuilds what only changes on reset: obstacles, the leaf instances, the rover and the pile zone. */
  private rebuildWorld() {
    const { sim, seed } = this.controller
    if (this.obstacles) {
      this.obstacles.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        if (m.material) (m.material as THREE.Material).dispose()
      })
      this.obstacles.removeFromParent()
    }
    this.obstacles = buildObstacles(sim.world.obstacles ?? [])
    this.world.add(this.obstacles)

    if (this.leaves) {
      this.leaves.mesh.removeFromParent()
      this.leaves.dispose()
    }
    this.leaves = new LeafInstances(sim.leaves, seed)
    this.world.add(this.leaves.mesh)

    if (!this.rover) {
      const ap = sim.brain.options.autopilot
      this.rover = new RoverModel(sim.options, ap.scoopLipM, ap.scoopWidthM)
      this.world.add(this.rover.group)
    }
    this.pile.setPile(this.controller.frame.pile)
    this.pile.zone.visible = this.overlays.pileZone && this.controller.frame.pile != null
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(100, now - this.lastMs)
    this.lastMs = now
    const c = this.controller
    if (c.resets !== this.resets) {
      this.resets = c.resets
      this.rebuildWorld()
    }
    const frame = c.frame
    const pose = c.roverPose()
    const rover = this.rover!

    // Follow: drag the orbit target (and the camera with it) toward the rover, so orbiting still works.
    rover.update(pose.x, pose.z, pose.yawDeg, frame.scoop, dt)
    if (this.follow) {
      const k = 1 - Math.exp(-dt / 250)
      this.tmp.copy(rover.group.position).sub(this.controls.target).multiplyScalar(k)
      this.tmp.y = 0
      this.controls.target.add(this.tmp)
      this.camera.position.add(this.tmp)
    }

    this.pile.update(frame.stats.inPile, dt)
    this.leaves!.update(frame.leaves, this.pile.heightAt, (out, i) => rover.scoopLeafPosition(out, i))

    const yaw = THREE.MathUtils.degToRad(pose.yawDeg)
    this.fov.position.set(pose.x, 0.008, pose.z)
    this.fov.rotation.y = -yaw
    if (this.overlays.trail) this.trail.update(c.trail)
    if (this.overlays.corridors) this.corridors.update(frame.tick.corridors, pose.x, pose.z, pose.yawDeg)
    if (this.overlays.belief) this.belief.update(frame)
    this.goal.update(goalOf(frame), pose.x, pose.z)

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  private resize = () => {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private setPointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
  }

  /** The draggable leaf under the pointer, if any. */
  private pickLeaf(e: PointerEvent): number | null {
    if (!this.leaves) return null
    this.setPointer(e)
    const hit = this.raycaster.intersectObject(this.leaves.mesh, false)[0]
    const id = hit?.instanceId != null ? this.leaves.idAt(hit.instanceId) : undefined
    if (id == null) return null
    return this.controller.frame.leaves.find((l) => l.id === id)?.where === 'scoop' ? null : id
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const id = this.pickLeaf(e)
    if (id == null) return
    this.dragging = id
    this.controls.enabled = false
    this.renderer.domElement.setPointerCapture(e.pointerId)
    this.renderer.domElement.style.cursor = 'grabbing'
    e.stopImmediatePropagation()
  }

  private onMove = (e: PointerEvent) => {
    if (this.dragging == null) {
      if (e.buttons === 0) this.renderer.domElement.style.cursor = this.pickLeaf(e) != null ? 'grab' : ''
      return
    }
    this.setPointer(e)
    const p = this.raycaster.ray.intersectPlane(this.groundPlane, this.tmp)
    if (p && !this.controller.moveLeaf(this.dragging, p.x, p.z)) this.endDrag(e)
  }

  private onUp = (e: PointerEvent) => {
    if (this.dragging != null) this.endDrag(e)
  }

  private endDrag(e: PointerEvent) {
    this.dragging = null
    this.controls.enabled = true
    const el = this.renderer.domElement
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    el.style.cursor = 'grab'
  }
}
