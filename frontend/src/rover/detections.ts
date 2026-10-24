/**
 * The leaf detector's boxes as the rover app streams them at `/detections` (usePublishDetections in
 * mobile/src/hooks/use-camera-stream.ts): one JSON line per detector frame.
 */

/** One box: corners as fractions of the upright camera frame, its colour and tag as the phone draws them. */
export type StreamedBox = {
  id: number
  x0: number
  y0: number
  x1: number
  y1: number
  color: string
  /** e.g. "dry leaf 1.4 m · ✕ too big": the camera screen's tag for it. */
  text: string
  /** The tracker didn't see it in this frame: it's where it was last seen. */
  coasting: boolean
}

export type DetectionFrame = {
  /** When the phone published it (its clock), ms. */
  t: number
  /** The upright frame the boxes are fractions of, in pixels (0 when there's no result). */
  width: number
  height: number
  boxes: StreamedBox[]
}

/** Splits a byte stream into lines as they complete, holding back a partial last line. */
export class LineSplitter {
  private pending = ''
  private decoder = new TextDecoder()

  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true })
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.filter((line) => line.trim() !== '')
  }
}

/** A line as a detection frame, or null if it isn't one. */
export function parseDetectionFrame(line: string): DetectionFrame | null {
  try {
    const frame = JSON.parse(line) as DetectionFrame
    return Array.isArray(frame.boxes) ? frame : null
  } catch {
    return null
  }
}
