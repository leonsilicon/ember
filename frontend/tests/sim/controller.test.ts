import { describe, expect, test } from 'bun:test'
import { FOOT_M, RoverSim } from '@rover-brain'
import { isDone, SimController } from '../../src/sim/controller'
import { WORLDS } from '../../src/sim/worlds'

/** Backyard leaves within the default 6 ft circle round the pile (at the origin). */
const backyardInCircle = WORLDS.Backyard.leaves.filter(([x, z]) => Math.hypot(x, z) <= 6 * FOOT_M).length

describe('SimController', () => {
  test('starts on the pile in the Backyard, with every leaf on the ground', () => {
    const c = new SimController()
    expect(c.worldName).toBe('Backyard')
    expect(c.frame.rover.position[0]).toBe(0)
    expect(c.frame.rover.position[2]).toBe(0)
    expect(c.frame.stats.onGround).toBe(WORLDS.Backyard.leaves.length)
    expect(c.frame.stats.inRange).toBe(backyardInCircle)
    expect(c.frame.stats.inPile).toBe(0)
  })

  test('the work circle defaults to 6 ft and changes the running brain', () => {
    const c = new SimController()
    expect(c.workRadiusFt).toBe(6)
    expect(c.sim.brain.options.autopilot.workRadiusM).toBeCloseTo(1.8288, 4)
    c.setWorkRadiusFt(12)
    expect(c.sim.brain.options.autopilot.workRadiusM).toBeCloseTo(12 * FOOT_M, 4)
    expect(c.frame.stats.inRange).toBeGreaterThan(backyardInCircle)
    c.setWorkRadiusFt(40)
    expect(c.workRadiusFt).toBe(12)
    c.reset()
    expect(c.sim.brain.options.autopilot.workRadiusM).toBeCloseTo(12 * FOOT_M, 4)
  })

  test('advance moves the rover and grows the trail', () => {
    const c = new SimController()
    for (let i = 0; i < 150; i++) c.advance(100)
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
    expect(c.moveLeaf(id, 0.2, 0.1)).toBe(true)
    expect(c.sim.leaves[0].position).toEqual([0.2, 0, 0.1])
    expect(c.sim.world.leaves[0]).toEqual([0.2, 0.1])
    expect(c.frame.stats.inPile).toBe(1)
    expect(c.frame.stats.onGround).toBe(WORLDS.Backyard.leaves.length - 1)
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
    expect(c.leafAt(0.9, -0.5)).toBe(1)
    expect(c.leafAt(1.0, -0.5)).toBeNull()
  })

  test('leaves per trip defaults to 4 and changes the running brain', () => {
    const c = new SimController()
    expect(c.capacity).toBe(4)
    expect(c.sim.brain.options.autopilot.capacity).toBe(4)
    c.setCapacity(2)
    expect(c.sim.brain.options.autopilot.capacity).toBe(2)
    c.reset()
    expect(c.sim.brain.options.autopilot.capacity).toBe(2)
  })

  test('moving the pile restarts the run with the rover on it; not onto a trunk', () => {
    const c = new SimController() // Backyard: a trunk at (1.3, -1.2)
    for (let i = 0; i < 50; i++) c.advance(100)
    expect(c.setPile(1.3, -1.2)).toBe(false)
    expect(c.setPile(-0.5, 1.5)).toBe(true)
    expect(c.frame.timeMs).toBe(0)
    expect(c.frame.pile?.center).toEqual([-0.5, 0, 1.5])
    expect(c.frame.rover.position[0]).toBeCloseTo(-0.5)
    expect(c.frame.rover.position[2]).toBeCloseTo(1.5)
    c.reset()
    expect(c.sim.brain.pile?.center).toEqual([-0.5, 0, 1.5])
    c.resetPile()
    expect(c.sim.brain.pile?.center).toEqual(WORLDS.Backyard.pile!.center)
  })

  test('a run clears the circle round a moved pile and leaves the rest', () => {
    const c = new SimController()
    c.setPile(1.5, 1.5)
    const frame = c.sim.run(isDone, 20 * 60_000)
    expect(frame.stats.inRange).toBe(0)
    expect(frame.stats.onGround).toBeGreaterThan(0) // the leaves outside the circle
    for (const l of frame.leaves) {
      if (l.where === 'pile') expect(Math.hypot(l.position[0] - 1.5, l.position[2] - 1.5)).toBeLessThanOrEqual(0.75)
    }
  }, 30_000)

  for (const name of Object.keys(WORLDS)) {
    test(`'${name}' clears its 6 ft circle at seed 1, without collisions`, () => {
      const c = new SimController()
      c.setWorld(name)
      const frame = c.sim.run(isDone, 20 * 60_000)
      expect(frame.stats.inRange).toBe(0)
      expect(frame.stats.inScoop).toBe(0)
      expect(frame.stats.collisions).toBe(0)
    }, 30_000)
  }

  test("the brain is rover-brain's own (the sim imports it, not a copy)", () => {
    const c = new SimController()
    expect(c.sim).toBeInstanceOf(RoverSim)
  })
})
