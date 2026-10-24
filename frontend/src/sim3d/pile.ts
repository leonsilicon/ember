import * as THREE from 'three'
import type { Pile } from '@rover-brain'
import { moundSize } from '../sim/controller'
import { PALETTE } from '../sim/overlays'
import { DRY_LEAF_COLORS } from './leaves'
import { random } from './random'

/**
 * The piled leaves' mound, sized by the sim's own formula (moundSize), so it's what the LiDAR sees,
 * plus the pile zone (its radius, drawn on the ground) as a toggleable overlay.
 */
export class PileModel {
  readonly mound: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  readonly zone = new THREE.Group()
  private heightM = 0
  private radiusM = 0
  private target = { heightM: 0, radiusM: 0 }
  private pile: Pile | null = null

  constructor() {
    const g = new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2)
    const pos = g.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const rand = random(3)
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      // Lumpy: leaves heaped, not a dome. Keep the rim on the ground.
      const k = 1 + (y > 0.02 ? (rand() - 0.5) * 0.18 : 0)
      pos.setXYZ(i, pos.getX(i) * k, y * (1 + (rand() - 0.5) * 0.25), pos.getZ(i) * k)
      c.set(DRY_LEAF_COLORS[Math.floor(rand() * DRY_LEAF_COLORS.length)]).multiplyScalar(0.7 + rand() * 0.3)
      colors.set([c.r, c.g, c.b], i * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    this.mound = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }))
    this.mound.castShadow = true
    this.mound.receiveShadow = true
    this.mound.visible = false
    this.mound.raycast = () => {}

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.97, 1, 96),
      new THREE.MeshBasicMaterial({ color: PALETTE.pile, transparent: true, opacity: 0.85, depthWrite: false }),
    )
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.MeshBasicMaterial({ color: PALETTE.pile, transparent: true, opacity: 0.1, depthWrite: false }),
    )
    for (const m of [ring, disc]) {
      m.rotation.x = -Math.PI / 2
      m.raycast = () => {}
      this.zone.add(m)
    }
    this.zone.position.y = 0.006
    this.zone.renderOrder = 1
  }

  setPile(pile: Pile | null) {
    this.pile = pile
    this.zone.visible = pile != null
    if (!pile) return
    this.zone.position.set(pile.center[0], 0.006, pile.center[2])
    this.zone.scale.set(pile.radiusM, 1, pile.radiusM)
    this.mound.position.set(pile.center[0], 0, pile.center[2])
  }

  /** Grows (eased) toward the mound for `nPiled` leaves. */
  update(nPiled: number, dtMs: number) {
    if (!this.pile) {
      this.mound.visible = false
      return
    }
    this.target = nPiled > 0 ? moundSize(nPiled, this.pile) : { heightM: 0, radiusM: 0 }
    const k = 1 - Math.exp(-dtMs / 300)
    this.heightM += (this.target.heightM - this.heightM) * k
    this.radiusM += (this.target.radiusM - this.radiusM) * k
    this.mound.visible = this.heightM > 0.002
    this.mound.scale.set(this.radiusM, this.heightM, this.radiusM)
  }

  /** The mound's surface height at (x, z), for laying piled leaves on it. */
  heightAt = (x: number, z: number) => {
    if (!this.pile || this.radiusM <= 0) return 0
    const d = Math.hypot(x - this.pile.center[0], z - this.pile.center[2]) / this.radiusM
    return d >= 1 ? 0 : this.heightM * Math.sqrt(1 - d * d)
  }
}
