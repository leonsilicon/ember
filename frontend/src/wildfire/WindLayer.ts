import type { Map as MLMap } from 'maplibre-gl'
import { sampleWind, type WindField } from './live'

interface Streak {
  x: number
  y: number
  age: number
  life: number
}

const COUNT = 700

/** Screen-space wind streaks drifting with an interpolated Open-Meteo field; fading trails on a 2D canvas. */
export class WindLayer {
  private ctx: CanvasRenderingContext2D
  private ps: Streak[] = []
  private raf = 0
  field: WindField | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private map: MLMap,
  ) {
    this.ctx = canvas.getContext('2d')!
    this.resize()
    map.on('move', this.clear)
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
    this.map.off('move', this.clear)
    this.ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight)
  }

  private clear = () => this.ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight)

  private spawn(w: number, h: number): Streak {
    return { x: Math.random() * w, y: Math.random() * h, age: 0, life: 40 + Math.random() * 80 }
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame)
    const { ctx, canvas, map, field } = this
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!field) return
    while (this.ps.length < COUNT) this.ps.push(this.spawn(w, h))
    // fade the previous trails
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = 'rgba(0,0,0,0.9)'
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineWidth = 1.2
    ctx.strokeStyle = 'rgba(214,232,255,0.75)'
    ctx.beginPath()
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i]
      const ll = map.unproject([p.x, p.y])
      const [ue, vn] = sampleWind(field, ll.lng, ll.lat)
      // screen direction of a small step along the wind, so map bearing and pitch are respected
      const step = 0.0005
      const q = map.project([ll.lng + (ue * step) / Math.cos((ll.lat * Math.PI) / 180), ll.lat + vn * step])
      const dx = q.x - p.x, dy = q.y - p.y
      const len = Math.hypot(dx, dy) || 1
      const speed = 0.4 + Math.hypot(ue, vn) * 0.09 // px per frame, sped up so it reads at demo scale
      const nx = p.x + (dx / len) * speed, ny = p.y + (dy / len) * speed
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(nx, ny)
      p.x = nx
      p.y = ny
      if (++p.age > p.life || nx < 0 || ny < 0 || nx > w || ny > h) this.ps[i] = this.spawn(w, h)
    }
    ctx.stroke()
  }
}
