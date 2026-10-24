import * as THREE from 'three'
import type { ScoopPosition, SimOptions } from '@rover-brain'

/** Scoop poses: how far the hinge rises (m) and how the tray pitches (rad; + lifts the lip). */
const SCOOP_POSES: Record<ScoopPosition, { lift: number; pitch: number }> = {
  down: { lift: 0, pitch: 0 },
  up: { lift: 0.03, pitch: THREE.MathUtils.degToRad(32) },
  dump: { lift: 0.09, pitch: THREE.MathUtils.degToRad(-55) },
}
const WHEEL_R = 0.05
const TRAY_METAL = new THREE.Color('#b8bcc4')
const TRAY_DOWN = new THREE.Color('#4ade80')
const TRAY_DUMP = new THREE.Color('#e0953a')

type Dims = { axleBackM: number; cameraHeightM: number; cameraPitchDeg: number; trackWidthM: number; scoopLipM: number; scoopWidthM: number }

/**
 * The rover, life size in metres. The group's origin is the wheel axle's centre on the ground, its
 * forward is local −z (so `rotation.y = −yaw` matches the sim), and the phone (the sim's camera) sits
 * `axleBackM` ahead of the axle at `cameraHeightM`. The scoop is hinged on the chassis front, its lip
 * `scoopLipM` ahead of the camera when it's down.
 */
export class RoverModel {
  readonly group = new THREE.Group()
  private scoop = new THREE.Group()
  private trayMat = new THREE.MeshStandardMaterial({ color: TRAY_METAL, metalness: 0.6, roughness: 0.45 })
  private wheels: { mesh: THREE.Object3D; side: -1 | 1 }[] = []
  private lift = SCOOP_POSES.up.lift
  private pitch = SCOOP_POSES.up.pitch
  private trayCenter = new THREE.Vector3()
  private lastPos: THREE.Vector3 | null = null
  private lastYaw = 0
  private dims: Dims

  constructor(sim: Pick<SimOptions, 'axleBackM' | 'cameraHeightM' | 'cameraPitchDeg' | 'trackWidthM'>, scoopLipM: number, scoopWidthM: number) {
    this.dims = { ...sim, scoopLipM, scoopWidthM }
    const d = this.dims
    const body = new THREE.MeshStandardMaterial({ color: '#f59e0b', roughness: 0.5, metalness: 0.1 })
    const dark = new THREE.MeshStandardMaterial({ color: '#27272a', roughness: 0.7 })
    const rubber = new THREE.MeshStandardMaterial({ color: '#111113', roughness: 0.95 })
    const hubMat = new THREE.MeshStandardMaterial({ color: '#d4d4d8', metalness: 0.5, roughness: 0.4 })
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.castShadow = true
      m.receiveShadow = true
      parent.add(m)
      return m
    }

    // Chassis: a body box with a dark deck and bumper.
    const chassisW = d.trackWidthM - 0.06
    add(this.group, new THREE.BoxGeometry(chassisW, 0.07, 0.28), body, 0, 0.085, 0)
    add(this.group, new THREE.BoxGeometry(chassisW - 0.02, 0.012, 0.24), dark, 0, 0.126, 0.01)
    add(this.group, new THREE.BoxGeometry(chassisW + 0.01, 0.025, 0.02), dark, 0, 0.065, 0.145)

    // Four wheels at ±track/2, ±0.09 m fore and aft, with a hub and a bolt so they visibly spin.
    const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.035, 20).rotateZ(Math.PI / 2)
    const hub = new THREE.CylinderGeometry(0.022, 0.022, 0.038, 12).rotateZ(Math.PI / 2)
    const bolt = new THREE.BoxGeometry(0.04, 0.012, 0.012)
    for (const side of [-1, 1] as const) {
      for (const z of [-0.09, 0.09]) {
        const wheel = new THREE.Group()
        wheel.position.set((side * d.trackWidthM) / 2, WHEEL_R, z)
        add(wheel, tyre, rubber, 0, 0, 0)
        add(wheel, hub, hubMat, 0, 0, 0)
        add(wheel, bolt, hubMat, 0, 0.03, 0)
        this.group.add(wheel)
        this.wheels.push({ mesh: wheel, side })
      }
    }

    // Phone mast at the camera position, phone pitched down `cameraPitchDeg`, screen facing back.
    const camZ = -d.axleBackM
    add(this.group, new THREE.CylinderGeometry(0.008, 0.008, d.cameraHeightM - 0.13, 8), hubMat, 0, 0.13 + (d.cameraHeightM - 0.13) / 2, camZ)
    const phone = new THREE.Group()
    phone.position.set(0, d.cameraHeightM, camZ)
    phone.rotation.x = -THREE.MathUtils.degToRad(d.cameraPitchDeg)
    add(phone, new THREE.BoxGeometry(0.075, 0.15, 0.008), dark, 0, 0, 0)
    const screen = add(phone, new THREE.PlaneGeometry(0.066, 0.138), new THREE.MeshStandardMaterial({ color: '#0c4a6e', emissive: '#38bdf8', emissiveIntensity: 0.35 }), 0, 0, 0.0045)
    screen.castShadow = false
    add(phone, new THREE.CylinderGeometry(0.008, 0.008, 0.004, 12).rotateX(Math.PI / 2), hubMat, 0.022, 0.06, -0.005)
    this.group.add(phone)

    // Scoop: hinged on the chassis front. Relative to the hinge the tray runs from just ahead of it to
    // the lip, with its floor on the ground when the scoop is down.
    const hingeY = 0.09
    const hingeZ = -0.14
    this.scoop.position.set(0, hingeY, hingeZ)
    const lipZ = camZ - d.scoopLipM - hingeZ
    const depth = -lipZ - 0.01
    const w = d.scoopWidthM
    const floorY = -hingeY + 0.006
    add(this.scoop, new THREE.BoxGeometry(w, 0.006, depth), this.trayMat, 0, floorY, -0.01 - depth / 2)
    for (const sx of [-1, 1]) add(this.scoop, new THREE.BoxGeometry(0.006, 0.05, depth), this.trayMat, (sx * w) / 2, floorY + 0.025, -0.01 - depth / 2)
    add(this.scoop, new THREE.BoxGeometry(w, hingeY, 0.006), this.trayMat, 0, -hingeY / 2, -0.01)
    add(this.scoop, new THREE.CylinderGeometry(0.01, 0.01, w, 10).rotateZ(Math.PI / 2), dark, 0, 0, 0)
    this.trayCenter.set(0, floorY + 0.012, -0.01 - depth * 0.55)
    this.group.add(this.scoop)
    this.applyScoop()
  }

  /**
   * Places the rover from the sim camera's ground position and yaw (degrees), and eases the scoop toward
   * `scoop`. `dtMs` is real time since the last call.
   */
  update(camX: number, camZ: number, yawDeg: number, scoop: ScoopPosition, dtMs: number) {
    const yaw = THREE.MathUtils.degToRad(yawDeg)
    const fx = Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const x = camX - fx * this.dims.axleBackM
    const z = camZ - fz * this.dims.axleBackM
    this.group.position.set(x, 0, z)
    this.group.rotation.y = -yaw

    // Wheel spin from the distance each side rolled (the left side runs faster in a right turn).
    if (this.lastPos) {
      const ds = (x - this.lastPos.x) * fx + (z - this.lastPos.z) * fz
      const dyaw = yaw - this.lastYaw
      for (const w of this.wheels) {
        const roll = ds - (w.side * dyaw * this.dims.trackWidthM) / 2
        w.mesh.rotation.x -= roll / WHEEL_R
      }
    } else {
      this.lastPos = new THREE.Vector3()
    }
    this.lastPos.set(x, 0, z)
    this.lastYaw = yaw

    const pose = SCOOP_POSES[scoop]
    const k = 1 - Math.exp(-dtMs / 120)
    this.lift += (pose.lift - this.lift) * k
    this.pitch += (pose.pitch - this.pitch) * k
    this.trayMat.color.copy(scoop === 'down' ? TRAY_DOWN : scoop === 'dump' ? TRAY_DUMP : TRAY_METAL)
    this.applyScoop()
  }

  /** Where a carried leaf rides: inside the tray, in world space. */
  scoopLeafPosition(out: THREE.Vector3, i = 0) {
    this.group.updateMatrixWorld()
    out.copy(this.trayCenter)
    out.x += ((i % 3) - 1) * 0.04
    out.y += Math.floor(i / 3) * 0.01
    return this.scoop.localToWorld(out)
  }

  private applyScoop() {
    this.scoop.position.y = 0.09 + this.lift
    this.scoop.rotation.x = this.pitch
  }
}
