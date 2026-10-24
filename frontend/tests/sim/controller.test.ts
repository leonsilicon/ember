import { describe, expect, test } from 'bun:test'
import { RoverSim } from '@rover-brain'
import { isDone, SimController } from '../../src/sim/controller'
import { WORLDS } from '../../src/sim/worlds'

describe('SimController', () => {
  test('reset puts every Cluttered yard leaf on the ground', () => {
    const c = new SimController()
    expect(c.worldName).toBe('Cluttered yard')
    expect(c.frame.stats.onGround).toBe(8)
    expect(c.frame.stats.inPile).toBe(0)
  })

  test('advance moves the rover and grows the trail', () => {
    const c = new SimController()
    for (let i = 0; i < 100; i++) c.advance(100)
    expect(c.frame.timeMs).toBeGreaterThan(0)
    expect(c.trail.length).toBeGreaterThan(10)
    const [x, , z] = c.frame.rover.position
    expect(Math.hypot(x, z)).toBeGreaterThan(0.05)
  })

  test('pausing stops stepping', () => {
    const c = new SimController()
    c.togglePlaying()
    expect(c.advance(100)).toBe(false)
    expect(c.frame.timeMs).toBe(0)
    c.togglePlaying()
    expect(c.advance(100)).toBe(true)
  })

  test('moveLeaf moves the truth and reclassifies it straight away, even paused', () => {
    const c = new SimController()
    c.togglePlaying()
    const id = c.sim.leaves[0].id
    expect(c.moveLeaf(id, 0.2, 1.1)).toBe(true)
    expect(c.sim.leaves[0].position).toEqual([0.2, 0, 1.1])
    expect(c.sim.world.leaves[0]).toEqual([0.2, 1.1])
    expect(c.frame.stats.inPile).toBe(1)
    expect(c.frame.stats.onGround).toBe(7)
  })

  test('a moved leaf stays where it was put while the sim runs', () => {
    const c = new SimController()
    c.moveLeaf(1, 3.4, 2.2)
    for (let i = 0; i < 20; i++) c.advance(100)
    const leaf = c.frame.leaves.find((l) => l.id === 1)!
    expect(leaf.position[0]).toBeCloseTo(3.4)
    expect(leaf.position[2]).toBeCloseTo(2.2)
  })

  test('leafAt hits within 0.15 m and misses beyond', () => {
    const c = new SimController()
    expect(c.leafAt(0.1, -3)).toBe(1)
    expect(c.leafAt(0.2, -3)).toBeNull()
  })

  for (const name of Object.keys(WORLDS)) {
    test(`'${name}' clears within 20 sim-minutes at seed 1`, () => {
      const sim = new RoverSim(structuredClone(WORLDS[name]), { seed: 1 })
      sim.start()
      const frame = sim.run(isDone, 20 * 60_000)
      expect(frame.stats.inPile).toBe(WORLDS[name].leaves.length)
    }, 30_000) // a whole job is ~10 sim-minutes, several seconds of real time on the busier yards
  }
})
