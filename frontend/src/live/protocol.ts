/**
 * Wire formats of the live reconstruction.
 *
 * Phone → server (`/live/ingest`): binary WebSocket messages, each a u32 little-endian header
 * length, a JSON header, then the header's payload bytes. The phone sends `hello` first, then
 * `pose` about 15 times a second and a `keyframe` whenever it has moved enough. Server → phone:
 * JSON text messages (`stats`, `error`).
 *
 * Server → browser (`/live/socket`): JSON text messages (`session`, `pose`, `stats`) and binary
 * messages whose first u32 says what they hold: POINTS (voxels to add or update) or KEYFRAME
 * (the camera image of a fused keyframe, for drawing on the phone's frustum).
 */
import { USERNAME } from '../rooms';
import type { Intrinsics } from './geometry';
import type { VoxelCloud } from './voxels';

export type CaptureMode = 'features' | 'lidar';

/** `room`: the username set in the app, whose browsers this recording shows to (see rooms.ts); none from older builds. */
export type HelloHeader = { type: 'hello'; session: string; mode: CaptureMode; device?: string; room?: string };

/** Camera-to-world pose, column-major. `t` is ARKit's frame timestamp in seconds. */
export type PoseHeader = { type: 'pose'; t: number; pose: number[] };

export type KeyframeHeader = {
  type: 'keyframe';
  seq: number;
  t: number;
  pose: number[];
  /** Of the JPEG. */
  intrinsics: Intrinsics;
  /** World points of known depth seen in this frame (ARKit's feature points), flat x, y, z. */
  anchors?: number[];
  jpegBytes: number;
  /** LiDAR depth after the JPEG: float32 metres, then uint8 ARKit confidence (0–2) if flagged. */
  depth?: { width: number; height: number; confidence: boolean };
};

export type IngestHeader = HelloHeader | PoseHeader | KeyframeHeader;

export class ProtocolError extends Error {}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

function isPose(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);
}

function isIntrinsics(k: unknown): k is Intrinsics {
  if (!k || typeof k !== 'object') return false;
  const { fx, fy, cx, cy, width, height } = k as Record<string, unknown>;
  return [fx, fy, cx, cy].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    [width, height].every((n) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 8192) &&
    (fx as number) > 0 && (fy as number) > 0;
}

export function parseIngest(data: Uint8Array): { header: IngestHeader; payload: Uint8Array } {
  if (data.byteLength < 4) throw new ProtocolError('message too short');
  const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  if (4 + headerLength > data.byteLength) throw new ProtocolError('header runs past the message');
  let header: Record<string, any>;
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength)));
  } catch {
    throw new ProtocolError('header is not JSON');
  }
  const payload = data.subarray(4 + headerLength);
  switch (header?.type) {
    case 'hello':
      if (typeof header.session !== 'string' || !SESSION_ID.test(header.session)) throw new ProtocolError('bad session id');
      if (header.mode !== 'features' && header.mode !== 'lidar') throw new ProtocolError('bad mode');
      if (header.room !== undefined && !(typeof header.room === 'string' && USERNAME.test(header.room))) throw new ProtocolError('bad room');
      return { header: header as HelloHeader, payload };
    case 'pose':
      if (!isPose(header.pose)) throw new ProtocolError('bad pose');
      return { header: header as PoseHeader, payload };
    case 'keyframe': {
      if (!isPose(header.pose) || !isIntrinsics(header.intrinsics)) throw new ProtocolError('bad keyframe camera');
      if (header.anchors !== undefined && !(Array.isArray(header.anchors) && header.anchors.every(Number.isFinite))) {
        throw new ProtocolError('bad anchors');
      }
      const depth = header.depth;
      const depthBytes = depth ? depth.width * depth.height * (depth.confidence ? 5 : 4) : 0;
      if (depth && !(Number.isInteger(depth.width) && Number.isInteger(depth.height) && depth.width > 0 && depth.height > 0)) {
        throw new ProtocolError('bad depth size');
      }
      if (!Number.isInteger(header.jpegBytes) || header.jpegBytes <= 0 || header.jpegBytes + depthBytes !== payload.byteLength) {
        throw new ProtocolError('payload size does not match the header');
      }
      return { header: header as KeyframeHeader, payload };
    }
    default:
      throw new ProtocolError(`unknown message type ${String(header?.type)}`);
  }
}

/** Builds a phone message (used by the replay script and tests). */
export function encodeIngest(header: IngestHeader, ...payload: Uint8Array[]) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const total = 4 + json.byteLength + payload.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  let offset = 4 + json.byteLength;
  for (const part of payload) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export const VIEWER_POINTS = 1;
export const VIEWER_KEYFRAME = 2;

/**
 * Voxels for the viewer, laid out so it can view each part without copying: u32 kind, u32 count,
 * u32 index × count, f32 x/y/z × count, then u8 r/g/b/views × count (views capped at 255).
 */
export function encodePoints(cloud: VoxelCloud, indices: ArrayLike<number>) {
  const count = indices.length;
  const out = new ArrayBuffer(8 + count * 20);
  const head = new Uint32Array(out, 0, 2);
  head[0] = VIEWER_POINTS;
  head[1] = count;
  const index = new Uint32Array(out, 8, count);
  const position = new Float32Array(out, 8 + count * 4, count * 3);
  const color = new Uint8Array(out, 8 + count * 16, count * 4);
  for (let j = 0; j < count; j++) {
    const i = indices[j];
    index[j] = i;
    position[j * 3] = cloud.positions[i * 3];
    position[j * 3 + 1] = cloud.positions[i * 3 + 1];
    position[j * 3 + 2] = cloud.positions[i * 3 + 2];
    color[j * 4] = cloud.colors[i * 3];
    color[j * 4 + 1] = cloud.colors[i * 3 + 1];
    color[j * 4 + 2] = cloud.colors[i * 3 + 2];
    color[j * 4 + 3] = Math.min(cloud.views[i], 255);
  }
  return new Uint8Array(out);
}

/** u32 kind, u32 JSON length, JSON `{ seq, pose, intrinsics }`, then the JPEG. */
export function encodeKeyframe(info: { seq: number; pose: number[]; intrinsics: Intrinsics }, jpeg: Uint8Array) {
  const json = new TextEncoder().encode(JSON.stringify(info));
  const out = new Uint8Array(8 + json.byteLength + jpeg.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, VIEWER_KEYFRAME, true);
  view.setUint32(4, json.byteLength, true);
  out.set(json, 8);
  out.set(jpeg, 8 + json.byteLength);
  return out;
}
