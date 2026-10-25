import type { Map as MLMap } from 'maplibre-gl'
import { gridToLngLat, type FuelGrid } from './grid'

interface Particle {
  lon: number
  lat: number
  age: number
  life: number
  size: number
  seed: number
}

/**
 * Screen-space smoke: soft grey puffs spawned on the active fire front, drifting downwind and
 * growing as they rise. Pure 2D canvas on top of the map so it costs nothing when there is no fire.
 */
export class Smoke {
  private ps: Particle[] = []
  private raf = 0
  private last = 0
  private ctx: CanvasRenderingContext2D
  /** cells sorted by arrival time and the matching times, from the simulation */
  cells: Int32Array | null = null
  times: Float32Array | null = null
  t = -1
  playing = false
  windKmh = 15
  windFromDeg = 270

  private canvas: HTMLCanvasElement
  private map: MLMap
  private grid: FuelGrid

  constructor(canvas: HTMLCanvasElement, map: MLMap, grid: FuelGrid) {
    this.canvas = canvas
    this.map = map
    this.grid = grid
    this.ctx = canvas.getContext('2d')!
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const r = this.canvas.parentElement?.getBoundingClientRect()
    if (!r) return
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.canvas.style.width = `${r.width}px`
    this.canvas.style.height = `${r.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
  }

  private lowerBound(v: number) {
    const a = this.times!
    let lo = 0, hi = a.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (a[m] < v) lo = m + 1
      else hi = m
    }
    return lo
  }

  private spawn(count: number) {
    if (!this.cells || !this.times || this.t < 0) return
    const hi = this.lowerBound(this.t), lo = this.lowerBound(this.t - 30)
    if (hi <= lo) return
    for (let i = 0; i < count && this.ps.length < 500; i++) {
      const c = this.cells[lo + Math.floor(Math.random() * (hi - lo))]
      const row = Math.floor(c / this.grid.width), col = c - row * this.grid.width
      const [lon, lat] = gridToLngLat(this.grid, col + Math.random(), row + Math.random())
      this.ps.push({ lon, lat, age: 0, life: 6 + Math.random() * 6, size: 6 + Math.random() * 10, seed: Math.random() })
    }
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0.016)
    this.last = now
    const { ctx, canvas } = this
    const w = canvas.clientWidth, h = canvas.clientHeight
    ctx.clearRect(0, 0, w, h)
    if (this.t < 0) {
      this.ps.length = 0
      return
    }
    if (this.playing) this.spawn(Math.max(2, Math.round(60 * dt)))
    // wind TO direction, in degrees from east counter-clockwise; metres per second of drift (smoke rides ~60 % of the wind)
    const toRad = ((90 - ((this.windFromDeg + 180) % 360)) * Math.PI) / 180
    const mps = (this.windKmh / 3.6) * 0.6 * 6 // sped up so it reads at demo scale
    const zoom = this.map.getZoom()
    const mPerDegLat = 111_320
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i]
      p.age += dt
      if (p.age > p.life) {
        this.ps.splice(i, 1)
        continue
      }
      const jitter = (p.seed - 0.5) * 0.8
      const dx = Math.cos(toRad + jitter) * mps * dt, dy = Math.sin(toRad + jitter) * mps * dt
      p.lat += dy / mPerDegLat
      p.lon += dx / (mPerDegLat * Math.cos((p.lat * Math.PI) / 180))
      const pt = this.map.project([p.lon, p.lat])
      if (pt.x < -50 || pt.y < -50 || pt.x > w + 50 || pt.y > h + 50) continue
      const k = p.age / p.life
      const r = (p.size + k * 40) * 2 ** (zoom - 15)
      const a = 0.28 * (1 - k) * Math.min(1, p.age * 2)
      const g = ctx.createRadialGradient(pt.x, pt.y - r * 0.3 * k, 0, pt.x, pt.y - r * 0.3 * k, r)
      const shade = 55 + Math.round(60 * k)
      g.addColorStop(0, `rgba(${shade},${shade},${shade + 6},${a})`)
      g.addColorStop(1, `rgba(${shade},${shade},${shade + 6},0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(pt.x, pt.y - r * 0.3 * k, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
