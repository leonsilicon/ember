import { describe, expect, test } from 'bun:test'

import { DEFAULT_AUTOPILOT, initialAutopilotState, stepAutopilot, type LiveMap } from '@rover-brain'

import { directionFor, headingOf, inputFromMap, newMemory } from '#rover/webPilot.ts'

const map = (over: Partial<LiveMap> = {}): LiveMap => ({
  type: 'map',
  t: 0,
  rover: { x: 0, z: 0, yawDeg: 0 },
  pile: { x: 0, z: 0, radiusM: 0.75 },
  workRadiusM: 1.83,
  leaves: [],
  targetId: null,
  corridors: [-24, -16, -8, 0, 8, 16, 24].map((bearingDeg) => ({ bearingDeg, clearanceM: 2.5, blocked: false })),
  scanAgeMs: 50,
  autopilot: { on: false, mode: null, message: '' },
  load: 0,
  capacity: 4,
  dumped: 0,
  ...over,
})

describe('directionFor', () => {
  test('stopped, straight, spinning', () => {
    expect(directionFor(0, 2)).toBeNull()
    expect(directionFor(40, 40)).toBe('forward')
    expect(directionFor(-30, -30)).toBe('back')
    expect(directionFor(30, -30)).toBe('right')
    expect(directionFor(-25, 25)).toBe('left')
    // Mostly forward with a gentle curve stays forward.
    expect(directionFor(40, 30)).toBe('forward')
  })
})

describe('headingOf', () => {
  test('yaw 0 faces -z, yaw 90 faces +x (the brain’s convention)', () => {
    const north = headingOf({ x: 0, z: 0, yawDeg: 0 })
    expect(north.forward[2]).toBeCloseTo(-1)
    const east = headingOf({ x: 0, z: 0, yawDeg: 90 })
    expect(east.forward[0]).toBeCloseTo(1)
    expect(east.right[2]).toBeCloseTo(1)
  })
})

describe('the brain on a map line', () => {
  test('a leaf to the right gets a right turn, then forward once it is ahead', () => {
    const cfg = { ...DEFAULT_AUTOPILOT, workRadiusM: 1.83 }
    const leaf = { id: 1, x: 1, z: -0.2, state: 'confirmed' as const, seenAgoMs: 0 }
    const turning = stepAutopilot(initialAutopilotState(0), inputFromMap(map({ leaves: [leaf] }), 0, 0, newMemory()), cfg)
    expect(turning.state.targetId).toBe(1)
    expect(directionFor(turning.left, turning.right)).toBe('right')

    const facing = map({ rover: { x: 0, z: 0, yawDeg: 79 }, leaves: [leaf] })
    const driving = stepAutopilot(turning.state, inputFromMap(facing, 200, 0, newMemory()), cfg)
    expect(directionFor(driving.left, driving.right)).toBe('forward')
  })

  test('an old phone build without scan ages still counts its corridors as fresh', () => {
    const input = inputFromMap(map({ scanAgeMs: undefined }), 0, 100, newMemory())
    expect(input.scanAgeMs).toBe(100)
    expect(inputFromMap(map({ scanAgeMs: undefined, corridors: [] }), 0, 100, newMemory()).scanAgeMs).toBe(Infinity)
  })

  test('leaves the browser scooped count as collected', () => {
    const memory = newMemory()
    memory.collected.set(1, 5)
    const input = inputFromMap(map({ leaves: [{ id: 1, x: 1, z: 0, state: 'confirmed' }] }), 10, 0, memory)
    expect(input.leaves[0].state).toBe('collected')
  })
})
