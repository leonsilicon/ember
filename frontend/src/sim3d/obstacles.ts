import * as THREE from 'three'
import type { SimObstacle } from '@rover-brain'
import { random } from './random'

/** Cylinders this tall or taller are drawn as tree trunks; shorter ones as rocks. */
const TRUNK_MIN_HEIGHT_M = 0.6
/** Trunks are drawn this tall so they read as trees (the sim only cares about the footprint). */
const TRUNK_DRAWN_M = 2.5

function jitterColors(g: THREE.BufferGeometry, base: string, spread: number, rand: () => number) {
  const pos = g.attributes.position as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    c.set(base).multiplyScalar(1 - spread / 2 + rand() * spread)
    colors.set([c.r, c.g, c.b], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

function trunk(o: SimObstacle, rand: () => number) {
  const group = new THREE.Group()
  const bark = new THREE.CylinderGeometry(o.radiusM * 0.9, o.radiusM, TRUNK_DRAWN_M, 22, 10)
  const pos = bark.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    // Furrowed bark: wobble the radius a little per vertex column.
    const angle = Math.atan2(pos.getZ(i), pos.getX(i))
    const k = 1 + 0.06 * Math.sin(angle * 9 + pos.getY(i) * 2) + (rand() - 0.5) * 0.03
    pos.setX(i, pos.getX(i) * k)
    pos.setZ(i, pos.getZ(i) * k)
  }
  bark.computeVertexNormals()
  jitterColors(bark, '#4a4038', 0.35, rand)
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })
  const body = new THREE.Mesh(bark, mat)
  body.position.y = TRUNK_DRAWN_M / 2
  const flareGeo = new THREE.CylinderGeometry(o.radiusM, o.radiusM * 1.4, 0.16, 22)
  jitterColors(flareGeo, '#40372f', 0.3, rand)
  const flare = new THREE.Mesh(flareGeo, mat)
  flare.position.y = 0.08
  for (const m of [body, flare]) {
    m.castShadow = true
    m.receiveShadow = true
    group.add(m)
  }
  return group
}

function rock(o: SimObstacle, rand: () => number) {
  const g = new THREE.IcosahedronGeometry(1, 2)
  const pos = g.attributes.position as THREE.BufferAttribute
  // Same random offset for vertices that share a position, so the faces stay closed.
  const offsets = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`
    let k = offsets.get(key)
    if (k == null) offsets.set(key, (k = 0.85 + rand() * 0.25))
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k)
  }
  g.computeVertexNormals()
  jitterColors(g, '#7d7a72', 0.25, rand)
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }))
  // Footprint radius `radiusM`, top at `heightM`, base sunk a little into the ground.
  mesh.scale.set(o.radiusM, o.heightM * 0.6, o.radiusM * 0.95)
  mesh.position.y = o.heightM * 0.4
  mesh.rotation.y = rand() * Math.PI
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** The sim's obstacles (upright cylinders) as trunks and rocks with the same footprints. */
export function buildObstacles(obstacles: SimObstacle[]) {
  const group = new THREE.Group()
  obstacles.forEach((o, i) => {
    const rand = random(1000 + i)
    const obj = o.heightM >= TRUNK_MIN_HEIGHT_M ? trunk(o, rand) : rock(o, rand)
    obj.position.x = o.center[0]
    obj.position.z = o.center[1]
    obj.traverse((c) => {
      c.raycast = () => {}
    })
    group.add(obj)
  })
  return group
}
