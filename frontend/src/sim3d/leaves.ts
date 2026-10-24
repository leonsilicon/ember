import * as THREE from 'three'
import type { SimLeaf } from '@rover-brain'
import { random } from './random'

/** Dry-leaf colours sampled from the capture site (reference-frames/frame-03.jpg). */
export const DRY_LEAF_COLORS = ['#c9a46a', '#d9b13a', '#8a5a2b', '#c46a26', '#9a3f1f']

/**
 * A curled leaf about 1 unit long, lying along −z (tip forward) with its edges cupped up. Built from a
 * subdivided plane squeezed into a leaf outline, so the curl bends the whole blade, not just its rim.
 * Vertex colours lighten the midrib and darken the edges and tip.
 */
export function makeLeafGeometry(curl = 1) {
  const g = new THREE.PlaneGeometry(1, 1, 8, 12)
  const pos = g.attributes.position as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    const t = v + 0.5
    // Pointed tip, rounded base, a few shallow lobes.
    const halfW = 0.3 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.85) * (1 + 0.1 * Math.sin(t * Math.PI * 6))
    const x = u * 2 * halfW
    const cup = 1.1 * curl * x * x
    const tipLift = 0.35 * curl * Math.max(0, t - 0.55) ** 2 + 0.2 * curl * Math.max(0, 0.25 - t) ** 2
    pos.setXYZ(i, x, cup + tipLift, -v)
    const shade = 1 - 0.35 * Math.abs(u * 2) - 0.15 * Math.max(0, t - 0.75)
    colors.set([shade, shade, shade], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  return g
}

export function makeLeafMaterial() {
  return new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.85, metalness: 0 })
}

type LeafLook = { scale: number; yaw: number; tiltX: number; tiltZ: number; color: THREE.Color }

/** The sim's leaves as one InstancedMesh, each with a stable size, angle and colour derived from its id. */
export class LeafInstances {
  readonly mesh: THREE.InstancedMesh
  private looks: LeafLook[]
  private ids: number[]
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private p = new THREE.Vector3()
  private s = new THREE.Vector3()

  constructor(leaves: SimLeaf[], seed: number) {
    this.ids = leaves.map((l) => l.id)
    this.looks = leaves.map((l) => {
      const r = random(l.id * 7919 + seed * 104729)
      const color = new THREE.Color(DRY_LEAF_COLORS[Math.floor(r() * DRY_LEAF_COLORS.length)])
      color.offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, (r() - 0.5) * 0.08)
      return { scale: 0.08 + r() * 0.06, yaw: r() * Math.PI * 2, tiltX: (r() - 0.5) * 0.35, tiltZ: (r() - 0.5) * 0.35, color }
    })
    this.mesh = new THREE.InstancedMesh(makeLeafGeometry(1), makeLeafMaterial(), Math.max(1, leaves.length))
    this.mesh.count = leaves.length
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.looks.forEach((look, i) => this.mesh.setColorAt(i, look.color))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** The leaf id of a raycast hit's instance. */
  idAt(instanceId: number): number | undefined {
    return this.ids[instanceId]
  }

  /**
   * Places each leaf: on the ground, on the mound surface if piled (`moundHeight` gives the surface at
   * x, z), or in the rover's scoop (`scoopAt` gives the tray's world position).
   */
  update(leaves: SimLeaf[], moundHeight: (x: number, z: number) => number, scoopAt: (out: THREE.Vector3, i: number) => void) {
    for (let i = 0; i < leaves.length && i < this.looks.length; i++) {
      const l = leaves[i]
      const look = this.looks[i]
      let tilt = 1
      if (l.where === 'scoop') {
        scoopAt(this.p, i)
        tilt = 0.6
      } else {
        const h = l.where === 'pile' ? moundHeight(l.position[0], l.position[2]) : 0
        this.p.set(l.position[0], 0.004 + h, l.position[2])
        if (h > 0) tilt = 2.2
      }
      this.e.set(look.tiltX * tilt, look.yaw, look.tiltZ * tilt)
      this.q.setFromEuler(this.e)
      this.s.setScalar(look.scale)
      this.m.compose(this.p, this.q, this.s)
      this.mesh.setMatrixAt(i, this.m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.computeBoundingSphere()
  }

  dispose() {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }
}
