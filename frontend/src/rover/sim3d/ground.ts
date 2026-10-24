import * as THREE from 'three'
import type { SimFrame } from '@rover-brain'
import { VIEW } from '../sim/worlds'
import { makeLeafGeometry } from './leaves'
import { fbm, random } from './random'

/**
 * What the rover drives on. The scene holds exactly one; `ProceduralGround` is the default. A later
 * `SplatGround` can wrap `GaussianSplats3D.DropInViewer` (a THREE.Group, in the installed package):
 * flip the splat's −y-up convention with `rotation.x = Math.PI`, align its floor to y = 0, and feed its
 * downsampled centres to `SimWorld.points` so the simulated LiDAR sees the real scene.
 */
export interface GroundLayer {
  object: THREE.Object3D
  update?(frame: SimFrame): void
  /** Decorative leaf litter on/off, if the layer has any. */
  setLitterVisible?(visible: boolean): void
  dispose(): void
}

const SIZE_M = 16
const TEX = 1024
const CENTER_X = (VIEW.x0 + VIEW.x1) / 2
const CENTER_Z = (VIEW.z0 + VIEW.z1) / 2

const GRASS = [new THREE.Color('#5d7a32'), new THREE.Color('#6f8a3a')]
const DRY = new THREE.Color('#8f8a4a')
const SOIL = new THREE.Color('#5b4630')
const LITTER_COLORS = ['#6b4a2a', '#7a5a32', '#5a3c22', '#806440', '#6d4f1f']

// The ground texture is the same every time, so it's painted once per page and reused by every mount.
let paintedCanvas: HTMLCanvasElement | null = null

function paintGround(): HTMLCanvasElement {
  if (paintedCanvas) return paintedCanvas
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TEX
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(TEX, TEX)
  const rand = random(42)
  const c = new THREE.Color()
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      // Metres across the plane.
      const mx = (x / TEX) * SIZE_M
      const mz = (y / TEX) * SIZE_M
      const n = fbm(mx * 0.6, mz * 0.6, 4)
      c.copy(GRASS[0]).lerp(GRASS[1], n)
      const dry = fbm(mx * 0.35 + 17, mz * 0.35 - 9, 3)
      c.lerp(DRY, Math.min(0.75, Math.max(0, (dry - 0.52) * 3)))
      const bare = fbm(mx * 0.8 - 40, mz * 0.8 + 12, 3)
      c.lerp(SOIL, Math.min(0.6, Math.max(0, (bare - 0.64) * 4)))
      // Blade-scale speckle.
      const k = 0.82 + rand() * 0.3
      const i = (y * TEX + x) * 4
      img.data[i] = Math.min(255, c.r * 255 * k)
      img.data[i + 1] = Math.min(255, c.g * 255 * k)
      img.data[i + 2] = Math.min(255, c.b * 255 * k)
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  paintedCanvas = canvas
  return canvas
}

/** A mown lawn with dry patches, worn soil and decorative leaf litter (not part of the sim). */
export class ProceduralGround implements GroundLayer {
  readonly object = new THREE.Group()
  private plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private litter: THREE.InstancedMesh

  constructor(maxAnisotropy = 1) {
    const map = new THREE.CanvasTexture(paintGround())
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = maxAnisotropy
    const bump = new THREE.CanvasTexture(paintGround())
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(SIZE_M, SIZE_M),
      new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 0.6, roughness: 1, metalness: 0 }),
    )
    this.plane.rotation.x = -Math.PI / 2
    this.plane.position.set(CENTER_X, 0, CENTER_Z)
    this.plane.receiveShadow = true
    this.object.add(this.plane)

    // Small, dark, flattened leaves: clearly darker and smaller than the sim's leaves, and not pickable.
    const count = 1200
    const rand = random(7)
    this.litter = new THREE.InstancedMesh(
      makeLeafGeometry(0.35),
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 1 }),
      count,
    )
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const color = new THREE.Color()
    for (let i = 0; i < count; i++) {
      p.set(CENTER_X + (rand() - 0.5) * (SIZE_M - 1), 0.002, CENTER_Z + (rand() - 0.5) * (SIZE_M - 1))
      e.set((rand() - 0.5) * 0.2, rand() * Math.PI * 2, (rand() - 0.5) * 0.2)
      q.setFromEuler(e)
      s.setScalar(0.035 + rand() * 0.035)
      m.compose(p, q, s)
      this.litter.setMatrixAt(i, m)
      color.set(LITTER_COLORS[Math.floor(rand() * LITTER_COLORS.length)]).multiplyScalar(0.75 + rand() * 0.2)
      this.litter.setColorAt(i, color)
    }
    this.litter.receiveShadow = true
    this.litter.raycast = () => {}
    this.object.add(this.litter)
  }

  setLitterVisible(visible: boolean) {
    this.litter.visible = visible
  }

  dispose() {
    this.plane.geometry.dispose()
    this.plane.material.map?.dispose()
    this.plane.material.bumpMap?.dispose()
    this.plane.material.dispose()
    this.litter.geometry.dispose()
    ;(this.litter.material as THREE.Material).dispose()
    this.litter.dispose()
    this.object.removeFromParent()
  }
}
