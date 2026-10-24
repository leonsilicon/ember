#!/usr/bin/env node
// Generates public/splats/leaf-floor.splat: a flat lawn/duff ground scattered with dry leaves, a few
// leaf piles, sticks and pebbles. Deterministic (seeded). Output is the antimatter15 .splat layout,
// 32 bytes per splat: float32 x,y,z | float32 scale x,y,z | uint8 r,g,b,a | uint8 quat w,x,y,z (q*128+128).
// World convention matches the viewer (cameraUp = [0,-1,0]): ground is the y=0 plane, "up" is -y.
// Usage: node scripts/make-leaf-splat.mjs [out]
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? resolve(here, '../public/splats/leaf-floor.splat'))

// ---------- deterministic helpers ----------
let seed = 20261105
const rand = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const range = (a, b) => a + (b - a) * rand()
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

// Smooth value noise for colour patches on the ground.
const hash2 = (ix, iz) => {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const noise2 = (x, z) => {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const sx = fx * fx * (3 - 2 * fx)
  const sz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz)
  const b = hash2(ix + 1, iz)
  const c = hash2(ix, iz + 1)
  const d = hash2(ix + 1, iz + 1)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}
const fbm = (x, z) => 0.55 * noise2(x, z) + 0.3 * noise2(x * 2.1 + 17, z * 2.1 - 5) + 0.15 * noise2(x * 4.3 - 9, z * 4.3 + 31)

// ---------- vector / quaternion ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => mul(a, 1 / Math.hypot(a[0], a[1], a[2]))

// Quaternion [w,x,y,z] for a rotation matrix whose columns are the orthonormal axes a, b, c.
function quatFromAxes(a, b, c) {
  const m00 = a[0], m10 = a[1], m20 = a[2]
  const m01 = b[0], m11 = b[1], m21 = b[2]
  const m02 = c[0], m12 = c[1], m22 = c[2]
  const tr = m00 + m11 + m22
  let w, x, y, z
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s
  }
  const l = Math.hypot(w, x, y, z)
  return [w / l, x / l, y / l, z / l]
}

// Orthonormal frame with c = normal and a roughly along `hint`.
function frame(normal, hint) {
  const c = norm(normal)
  let a = sub(hint, mul(c, dot(hint, c)))
  if (Math.hypot(...a) < 1e-6) a = Math.abs(c[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
  a = norm(a)
  const b = cross(c, a)
  return [a, b, c]
}

// ---------- splat buffer ----------
const MAX = 480_000
const buf = Buffer.alloc(MAX * 32)
let count = 0
const SUN = norm([0.45, -1, 0.3]) // light from above (-y), slightly in front/right

function emit(p, s, rgb, alpha, q) {
  if (count >= MAX) throw new Error('splat budget exceeded')
  const o = count * 32
  buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8)
  buf.writeFloatLE(s[0], o + 12); buf.writeFloatLE(s[1], o + 16); buf.writeFloatLE(s[2], o + 20)
  buf[o + 24] = clamp(Math.round(rgb[0]), 0, 255)
  buf[o + 25] = clamp(Math.round(rgb[1]), 0, 255)
  buf[o + 26] = clamp(Math.round(rgb[2]), 0, 255)
  buf[o + 27] = clamp(Math.round(alpha), 0, 255)
  for (let i = 0; i < 4; i++) buf[o + 28 + i] = clamp(Math.round(q[i] * 128 + 128), 0, 255)
  count++
}
const shade = (rgb, k) => [rgb[0] * k, rgb[1] * k, rgb[2] * k]
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]
const jitter = (rgb, amt) => {
  const k = 1 + gauss() * amt
  return [rgb[0] * k + gauss() * 4, rgb[1] * k + gauss() * 4, rgb[2] * k + gauss() * 4]
}

// ---------- layout ----------
const HALF = 2.3 // ground is a ~4.6 m square with soft edges
const edgeFade = (x, z) => clamp((HALF - Math.max(Math.abs(x), Math.abs(z))) / 0.35, 0, 1)

const piles = [
  { c: [0.75, 0.55], r: 0.32, h: 0.13, n: 110 },
  { c: [-0.95, 0.95], r: 0.26, h: 0.1, n: 80 },
  { c: [-0.2, -0.95], r: 0.22, h: 0.08, n: 60 },
  { c: [1.35, -0.75], r: 0.18, h: 0.06, n: 40 },
]
// How much a ground point sits under a pile (0..1); used to darken/shadow the grass there.
const pileShadow = (x, z) => {
  let s = 0
  for (const p of piles) {
    const d = Math.hypot(x - p.c[0], z - p.c[1]) / (p.r * 1.25)
    if (d < 1) s = Math.max(s, 1 - d * d)
  }
  return s
}
const leafShadows = [] // [x, z, radius] of scattered leaves, for contact darkening

// ---------- leaves ----------
const PALETTE = [
  hex(0x8a5a2b), // brown
  hex(0x7a4a22), // dark brown
  hex(0xc49a5a), // tan
  hex(0xb8894a), // light tan
  hex(0xd2782a), // orange
  hex(0xc4621f), // burnt orange
  hex(0x9a3b1e), // russet
  hex(0xc9a03a), // ochre/yellow
]

// Leaf outlines in local 2D (x along midrib from stem 0 to tip 1, y across), returning true if inside.
const SHAPES = {
  // Maple-like: lobed polar outline centred at x=0.5.
  maple: (x, y) => {
    const dx = (x - 0.45) / 0.55
    const dy = y / 0.55
    const r = Math.hypot(dx, dy)
    const th = Math.atan2(dy, dx)
    const lobes = 0.62 + 0.38 * Math.pow(Math.abs(Math.cos(2.5 * th)), 0.7)
    const notch = th > 2.6 || th < -2.6 ? 0.55 : 1 // indent at the stem
    return r < lobes * notch
  },
  // Oval with a pointed tip (birch / elm / beech-like).
  oval: (x, y) => {
    if (x < 0 || x > 1) return false
    const w = 0.36 * Math.pow(Math.sin(Math.PI * Math.pow(x, 0.85)), 0.9)
    return Math.abs(y) < w
  },
  // Oak-like: elongated with wavy rounded lobes.
  oak: (x, y) => {
    if (x < 0 || x > 1) return false
    const w = 0.3 * Math.pow(Math.sin(Math.PI * x), 0.7) * (0.72 + 0.28 * Math.cos(x * Math.PI * 9))
    return Math.abs(y) < w
  },
}
// Distance-to-vein mask (0 on a vein): midrib plus a few side veins.
function veinDist(kind, x, y) {
  if (kind === 'maple') {
    const dx = x - 0.45
    const th = Math.atan2(y, dx)
    let d = Infinity
    for (const a of [0, 1.26, -1.26, 2.3, -2.3]) {
      const ux = Math.cos(a), uy = Math.sin(a)
      const along = dx * ux + y * uy
      if (along > 0) d = Math.min(d, Math.abs(-dx * uy + y * ux))
    }
    void th
    return d
  }
  let d = Math.abs(y)
  for (let k = 1; k <= 5; k++) {
    const x0 = 0.12 + k * 0.14
    // side veins slanting towards the tip
    const vx = x - x0 - Math.abs(y) * 0.9
    d = Math.min(d, Math.abs(vx) * 0.8)
  }
  return d
}

/**
 * Builds one leaf. centre is on/above the ground, size is the leaf length (m), normal is the leaf's
 * face normal (roughly -y when lying flat), yaw hint sets the midrib direction.
 */
function leaf(centre, size, normal, midribHint, opts = {}) {
  const kind = opts.kind ?? pick(['maple', 'maple', 'oval', 'oak'])
  const inside = SHAPES[kind]
  const base = opts.color ?? pick(PALETTE)
  const tip = mix(base, pick(PALETTE), 0.45)
  const dryEdge = shade(base, 0.72)
  const [e1, e2, n] = frame(normal, midribHint)
  // Curl: the leaf cups (both sides lift) and the tip lifts a bit; amounts relative to size.
  const cup = range(0.15, 0.55) * (rand() < 0.2 ? 2.2 : 1)
  const lift = range(-0.05, 0.25)
  const twist = range(-0.25, 0.25)
  const h = (x, y) => size * (cup * y * y + lift * (x - 0.5) * (x - 0.5) * 0.6 + twist * (x - 0.5) * y * 0.5)
  const nSplats = clamp(Math.round(22000 * size * size), 45, 320)
  const spacing = size * Math.sqrt(0.32 / nSplats) // shape area ≈ 0.32 (unit leaf)
  const scale = spacing * 0.62
  const thick = Math.max(0.00035, size * 0.004)
  const stemCol = shade(base, 0.6)
  let made = 0
  let guard = 0
  while (made < nSplats && guard++ < nSplats * 8) {
    const x = rand() * 1.1 - 0.05
    const y = rand() * 1.2 - 0.6
    if (!inside(x, y)) continue
    // local surface point + normal from the height-field gradient
    const lx = (x - 0.5) * size
    const ly = y * size
    const hz = h(x, y)
    const eps = 0.01
    const dhx = (h(x + eps, y) - h(x - eps, y)) / (2 * eps * size)
    const dhy = (h(x, y + eps) - h(x, y - eps)) / (2 * eps * size)
    const p = add(centre, add(add(mul(e1, lx), mul(e2, ly)), mul(n, hz)))
    const sn = norm(sub(n, add(mul(e1, dhx), mul(e2, dhy))))
    const [a, b, c] = frame(sn, e1)
    // colour: base→tip gradient, darker dry edges, veins lighter/darker, simple sun shading
    let col = mix(base, tip, clamp(x, 0, 1))
    let edge = 0
    for (const [ox, oy] of [[0.07, 0], [-0.07, 0], [0, 0.07], [0, -0.07]]) if (!inside(x + ox, y + oy)) edge++
    if (edge) col = mix(col, dryEdge, 0.25 * edge)
    const vd = veinDist(kind, x, y)
    if (vd < 0.022) col = opts.lightVeins ? shade(col, 1.18) : mix(col, stemCol, 0.55)
    const sun = 0.68 + 0.42 * Math.abs(dot(sn, SUN))
    col = jitter(shade(col, sun * (opts.dim ?? 1)), 0.06)
    const q = quatFromAxes(a, b, c)
    emit(p, [scale * range(0.85, 1.2), scale * range(0.85, 1.2), thick], col, 245, q)
    made++
  }
  // stem (petiole)
  const stemLen = size * range(0.15, 0.3)
  const stemDir = norm(add(mul(e1, -1), mul(n, 0.15)))
  const stemStart = add(centre, mul(e1, (kind === 'maple' ? -0.05 : -0.5) * size))
  const steps = Math.max(3, Math.round(stemLen / 0.004))
  const [sa, sb, sc] = frame(cross(stemDir, n), stemDir)
  for (let i = 0; i < steps; i++) {
    const p = add(stemStart, mul(stemDir, (i / steps) * stemLen))
    emit(p, [stemLen / steps, 0.0009, 0.0009], jitter(stemCol, 0.05), 240, quatFromAxes(sa, sb, sc))
  }
}

function randomYaw() {
  const a = rand() * Math.PI * 2
  return [Math.cos(a), 0, Math.sin(a)]
}
function nearlyUp(maxTilt) {
  // -y is up; tilt it by a random small angle
  const t = rand() * maxTilt
  const a = rand() * Math.PI * 2
  return norm([Math.sin(t) * Math.cos(a), -Math.cos(t), Math.sin(t) * Math.sin(a)])
}

// ---------- ground ----------
const GRASS_DEEP = hex(0x4f6b2a)
const GRASS_LIGHT = hex(0x7d9440)
const GRASS_DRY = hex(0x8f8a4a)
const SOIL = hex(0x5e4a33)
const DUFF = hex(0x7a5e3e)
const groundColor = (x, z) => {
  const n1 = fbm(x * 1.3 + 3, z * 1.3 - 7)
  const n2 = fbm(x * 3.7 - 11, z * 3.7 + 2)
  let col = mix(GRASS_DEEP, GRASS_LIGHT, clamp(n1 * 1.4 - 0.2, 0, 1))
  col = mix(col, GRASS_DRY, clamp((n2 - 0.55) * 3, 0, 0.6))
  // worn soil/duff patches
  const bare = clamp((fbm(x * 0.9 - 40, z * 0.9 + 12) - 0.6) * 4, 0, 1)
  col = mix(col, mix(SOIL, DUFF, n2), bare * 0.85)
  return col
}

// Base layer: dense, flat, overlapping discs so there are no gaps.
{
  const N = 120_000
  const area = (2 * HALF) * (2 * HALF)
  const spacing = Math.sqrt(area / N)
  const up = [0, -1, 0]
  for (let i = 0; i < N; i++) {
    const x = range(-HALF, HALF)
    const z = range(-HALF, HALF)
    const fade = edgeFade(x, z)
    if (fade <= 0) continue
    const [a, b, c] = frame(nearlyUp(0.15), randomYaw())
    void up
    const shadow = pileShadow(x, z)
    const col = jitter(shade(groundColor(x, z), 0.82 - 0.35 * shadow), 0.1)
    const s = spacing * range(0.7, 1.15)
    emit([x, range(-0.002, 0.002), z], [s, s * range(0.6, 1), 0.0015], col, 255 * fade, quatFromAxes(a, b, c))
  }
}

// ---------- scattered leaves ----------
const SCATTER = 460
for (let i = 0; i < SCATTER; i++) {
  // denser near the piles (wind drift), sparse elsewhere
  let x, z
  if (rand() < 0.35) {
    const p = pick(piles)
    const r = p.r * (1.2 + Math.abs(gauss()) * 1.6)
    const a = rand() * Math.PI * 2
    x = p.c[0] + Math.cos(a) * r
    z = p.c[1] + Math.sin(a) * r
  } else {
    x = range(-HALF + 0.25, HALF - 0.25)
    z = range(-HALF + 0.25, HALF - 0.25)
  }
  if (edgeFade(x, z) < 0.6) continue
  const size = clamp(0.03 + Math.pow(rand(), 1.6) * 0.09, 0.03, 0.12)
  const tilt = rand() < 0.15 ? 0.7 : 0.22
  leaf([x, -(0.006 + rand() * 0.01), z], size, nearlyUp(tilt), randomYaw())
  leafShadows.push([x, z, size * 0.5])
}

// ---------- piles ----------
for (const p of piles) {
  for (let i = 0; i < p.n; i++) {
    // sample a dome: more leaves near the centre, height follows the dome profile
    const r = p.r * Math.sqrt(rand())
    const a = rand() * Math.PI * 2
    const x = p.c[0] + Math.cos(a) * r
    const z = p.c[1] + Math.sin(a) * r
    const t = r / p.r
    const top = p.h * (1 - t * t)
    const y = -(0.008 + top * Math.pow(rand(), 0.6))
    const size = clamp(0.04 + Math.pow(rand(), 1.4) * 0.08, 0.03, 0.12)
    // inner leaves are shaded by the ones above them
    const depth = 1 - (-y - 0.008) / Math.max(top, 1e-3)
    leaf([x, y, z], size, nearlyUp(0.5 + t * 0.6), randomYaw(), { dim: 0.7 + 0.3 * (1 - depth * 0.6) })
  }
}

// ---------- grass blades (sparse tufts poking through) ----------
{
  const N = 70_000
  for (let i = 0; i < N; i++) {
    const x = range(-HALF, HALF)
    const z = range(-HALF, HALF)
    const fade = edgeFade(x, z)
    if (fade <= 0.05) continue
    if (pileShadow(x, z) > 0.5) continue
    const bare = clamp((fbm(x * 0.9 - 40, z * 0.9 + 12) - 0.6) * 4, 0, 1)
    if (rand() < bare) continue
    const len = range(0.012, 0.035)
    const dir = norm([gauss() * 0.45, -1, gauss() * 0.45])
    const [a, b, c] = frame(cross(dir, [0, 0, 1]), dir)
    const col = jitter(shade(mix(groundColor(x, z), GRASS_LIGHT, 0.35), range(0.85, 1.2)), 0.08)
    emit(add([x, 0, z], mul(dir, len * 0.5)), [len * 0.5, 0.0012, 0.0006], col, 230 * fade, quatFromAxes(a, b, c))
  }
}

// ---------- sticks ----------
for (let i = 0; i < 9; i++) {
  const len = range(0.15, 0.55)
  const radius = range(0.004, 0.011)
  const cx = range(-1.8, 1.8)
  const cz = range(-1.8, 1.8)
  const dir = randomYaw()
  const side = norm(cross(dir, [0, -1, 0]))
  const base = pick([hex(0x5b4632), hex(0x4a3a2c), hex(0x6b5a48)])
  const steps = Math.round(len / (radius * 0.9))
  const ring = 6
  for (let k = 0; k <= steps; k++) {
    const t = k / steps - 0.5
    const bend = Math.sin(t * Math.PI) * len * 0.05
    const c0 = add([cx, -radius, cz], add(mul(dir, t * len), mul(side, bend)))
    for (let j = 0; j < ring; j++) {
      const ang = (j / ring) * Math.PI * 2
      const offN = add(mul(side, Math.cos(ang)), mul([0, -1, 0], Math.sin(ang)))
      const p = add(c0, mul(offN, radius * 0.75))
      const [a, b, c] = frame(offN, dir)
      const lit = 0.65 + 0.45 * Math.max(0, dot(offN, mul(SUN, -1)) * -1 + 0.5)
      emit(p, [radius * 0.9, radius * 0.6, radius * 0.35], jitter(shade(base, lit), 0.08), 250, quatFromAxes(a, b, c))
    }
  }
}

// ---------- pebbles ----------
for (let i = 0; i < 26; i++) {
  const r = range(0.008, 0.025)
  const cx = range(-2, 2)
  const cz = range(-2, 2)
  const base = pick([hex(0x8c8a84), hex(0x9e968a), hex(0x77736c), hex(0xa8a196)])
  const n = Math.round(30 + r * 2000)
  for (let k = 0; k < n; k++) {
    // points on the upper hemisphere of a squashed ellipsoid
    const u = rand() * Math.PI * 2
    const v = Math.acos(rand())
    const nrm = norm([Math.sin(v) * Math.cos(u), -Math.cos(v), Math.sin(v) * Math.sin(u)])
    const p = [cx + nrm[0] * r * 1.2, -r * 0.35 + nrm[1] * r * 0.7, cz + nrm[2] * r]
    const [a, b, c] = frame(nrm, [1, 0, 0])
    const lit = 0.6 + 0.5 * Math.max(0, dot(nrm, SUN))
    emit(p, [r * 0.35, r * 0.35, r * 0.12], jitter(shade(base, lit), 0.06), 255, quatFromAxes(a, b, c))
  }
}

// Darken the ground right under scattered leaves (contact shadows) by emitting a soft dark disc.
for (const [x, z, r] of leafShadows) {
  const [a, b, c] = frame([0, -1, 0], [1, 0, 0])
  emit([x, -0.003, z], [r * 0.9, r * 0.9, 0.001], [40, 36, 22], 70, quatFromAxes(a, b, c))
}

writeFileSync(out, buf.subarray(0, count * 32))
console.log(`wrote ${count.toLocaleString()} splats (${((count * 32) / 1e6).toFixed(1)} MB) to ${out}`)
