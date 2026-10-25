import { describe, expect, it } from 'bun:test'
import { directionalRos, headRos, isi, lengthToBreadth } from './fbp'

describe('fbp', () => {
  it('ISI matches the published example (FFMC 90, wind 20 km/h ≈ 11.7)', () => {
    expect(isi(90, 20)).toBeGreaterThan(11)
    expect(isi(90, 20)).toBeLessThan(12.5)
  })
  it('spruce spreads faster than aspen, non-fuel does not spread', () => {
    const I = isi(90, 20)
    expect(headRos(2, I, 10)).toBeGreaterThan(headRos(13, I, 10))
    expect(headRos(101, I, 10)).toBe(0)
    expect(headRos(102, I, 10)).toBe(0)
  })
  it('mixedwood interpolates between C-2 and D-1', () => {
    const I = isi(90, 20)
    const c2 = headRos(2, I, 10)
    const d1 = headRos(13, I, 10)
    const m50 = headRos(650, I, 10)
    expect(m50).toBeGreaterThan(d1)
    expect(m50).toBeLessThan(c2)
  })
  it('ellipse: head > flank > back, calm wind is a circle', () => {
    const lb = lengthToBreadth(20)
    expect(lb).toBeGreaterThan(1)
    const head = directionalRos(10, lb, 0)
    const flank = directionalRos(10, lb, Math.PI / 2)
    const back = directionalRos(10, lb, Math.PI)
    expect(head).toBeCloseTo(10)
    expect(head).toBeGreaterThan(flank)
    expect(flank).toBeGreaterThan(back)
    expect(directionalRos(10, lengthToBreadth(0), Math.PI)).toBeCloseTo(10)
  })
})
