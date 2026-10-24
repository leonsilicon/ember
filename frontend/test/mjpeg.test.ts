import { describe, expect, test } from 'bun:test'
import { MjpegParser } from '../src/rover/mjpeg'

const enc = new TextEncoder()
const part = (body: Uint8Array) =>
  new Uint8Array([...enc.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`), ...body, ...enc.encode('\r\n')])

describe('MjpegParser', () => {
  test('returns each frame, however the stream is chunked', () => {
    const a = new Uint8Array([0xff, 0xd8, 1, 2, 3])
    const b = enc.encode('second frame, with \r\n\r\n and --frame inside')
    const stream = new Uint8Array([...part(a), ...part(b)])
    for (const size of [1, 3, 7, stream.length]) {
      const parser = new MjpegParser()
      const frames: Uint8Array[] = []
      for (let i = 0; i < stream.length; i += size) frames.push(...parser.push(stream.subarray(i, i + size)))
      expect(frames).toEqual([a, b])
    }
  })

  test('waits for the rest of a frame', () => {
    const parser = new MjpegParser()
    const whole = part(new Uint8Array([9, 9, 9, 9]))
    expect(parser.push(whole.subarray(0, whole.length - 4))).toEqual([])
    expect(parser.push(whole.subarray(whole.length - 4))).toEqual([new Uint8Array([9, 9, 9, 9])])
  })
})
