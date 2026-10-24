/**
 * Splits an MJPEG stream (multipart/x-mixed-replace, as the rover app's camera server sends it) into its
 * JPEGs. Feed it the body's chunks as they arrive; it returns each complete frame. Parts are found by
 * their `Content-Length` header, so a JPEG containing the boundary text can't cut it short.
 */
export class MjpegParser {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array<ArrayBuffer>[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length)
    joined.set(this.buffer)
    joined.set(chunk, this.buffer.length)
    this.buffer = joined

    const frames: Uint8Array<ArrayBuffer>[] = []
    for (;;) {
      const headEnd = indexOf(this.buffer, HEAD_END)
      if (headEnd < 0) break
      const head = new TextDecoder().decode(this.buffer.subarray(0, headEnd))
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1])
      const start = headEnd + HEAD_END.length
      if (!Number.isFinite(length)) {
        // A part without a length (or junk before the first boundary): skip past its headers.
        this.buffer = this.buffer.slice(start)
        continue
      }
      if (this.buffer.length < start + length) break
      frames.push(this.buffer.slice(start, start + length))
      this.buffer = this.buffer.slice(start + length)
    }
    return frames
  }
}

const HEAD_END = new TextEncoder().encode('\r\n\r\n')

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
