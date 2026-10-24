import { describe, expect, test } from 'bun:test'
import { LineSplitter, parseDetectionFrame } from '../src/rover/detections'

describe('detection stream', () => {
  test('splits lines across chunks and holds back a partial one', () => {
    const lines = new LineSplitter()
    const enc = new TextEncoder()
    expect(lines.push(enc.encode('{"a":1}\n{"b"'))).toEqual(['{"a":1}'])
    expect(lines.push(enc.encode(':2}\n\n'))).toEqual(['{"b":2}'])
  })

  test('parses a frame and rejects anything else', () => {
    const frame = parseDetectionFrame(
      '{"t":1,"width":480,"height":640,"boxes":[{"id":3,"x0":0.1,"y0":0.2,"x1":0.3,"y1":0.4,"color":"#FFD60A","text":"dry leaf 1.4 m","coasting":false}]}',
    )
    expect(frame?.boxes[0].text).toBe('dry leaf 1.4 m')
    expect(parseDetectionFrame('not json')).toBeNull()
    expect(parseDetectionFrame('{"t":1}')).toBeNull()
  })
})
