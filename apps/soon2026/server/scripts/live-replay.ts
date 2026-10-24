#!/usr/bin/env bun
/**
 * Streams a saved capture into the live reconstruction as if a phone were recording it, so the
 * pipeline and the viewer (<server>/live) can be tried without the phone:
 *
 *   bun server/scripts/live-replay.ts <unzipped capture dir> [--server url] [--token token] [--fps 3]
 *
 * The server defaults to SPLAT_SERVER_URL (else `vercel dev` on http://localhost:8899), and the
 * token to SPLAT_TOKEN (both in server/.env.local after `vercel env pull`). The Mac agent has to
 * be running for anything to be reconstructed.
 *
 * Saved captures don't keep each frame's ARKit feature points, so the anchors come from the
 * capture's points.ply instead: the seed points each frame can see (nearest per screen cell).
 */
import path from 'node:path';

import WebSocket from 'ws';

import { readPlyPositions } from '../src/dataset';
import { anchorsInView, scaleIntrinsics, type Anchor, type Intrinsics } from '../src/live/geometry';
import type { SessionStats } from '../src/live/hub';
import { encodeIngest } from '../src/live/protocol';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const server = option('--server', process.env.SPLAT_SERVER_URL ?? 'http://localhost:8899').replace(/^http/, 'ws').replace(/\/+$/, '');
const token = option('--token', process.env.SPLAT_TOKEN ?? '');
const fps = Number(option('--fps', '3'));
const dir = args[0];
if (!dir) {
  console.error('usage: bun server/scripts/live-replay.ts <unzipped capture dir> [--server url] [--token token] [--fps n]');
  process.exit(2);
}

type Frame = { file_path: string; transform_matrix: number[][]; fl_x: number; fl_y: number; cx: number; cy: number; w: number; h: number };
const transforms = await Bun.file(path.join(dir, 'transforms.json')).json();
const frames: Frame[] = transforms.frames;
const info = await Bun.file(path.join(dir, 'capture.json')).json().catch(() => ({}));
const seed = transforms.ply_file_path ? await readPlyPositions(path.join(dir, transforms.ply_file_path)) : null;

/** Row-major transform_matrix → the column-major pose the live protocol uses. */
const columnMajor = (m: number[][]) => Array.from({ length: 16 }, (_, i) => m[i % 4][Math.floor(i / 4)]);

/** Seed points this camera sees: in view, and the nearest within each cell of a coarse grid. */
function visibleSeed(pose: number[], k: Intrinsics) {
  if (!seed) return [];
  const cells = 48;
  const nearest = new Map<number, Anchor>();
  for (const a of anchorsInView(seed, pose, k)) {
    const cell = Math.floor((a.v / k.height) * cells) * cells + Math.floor((a.u / k.width) * cells);
    const best = nearest.get(cell);
    if (!best || a.depth < best.depth) nearest.set(cell, a);
  }
  return [...nearest.values()].flatMap(({ index = 0 }) => [seed[index * 3], seed[index * 3 + 1], seed[index * 3 + 2]]);
}

/** Poses between two keyframes for the viewer's frustum: positions lerped, axes nlerped. */
function between(a: number[], b: number[], t: number) {
  const out = a.map((v, i) => v + (b[i] - v) * t);
  for (const c of [0, 4, 8]) {
    const n = Math.hypot(out[c], out[c + 1], out[c + 2]) || 1;
    for (let r = 0; r < 3; r++) out[c + r] /= n;
  }
  return out;
}

const session = `replay-${path.basename(dir).replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now().toString(36)}`.slice(0, 80);
const ws = new WebSocket(`${server}/live/ingest`, { headers: { Authorization: `Bearer ${token}` } });
ws.binaryType = 'arraybuffer';
const latest: { stats: SessionStats | null } = { stats: null };
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === 'stats') latest.stats = message.stats;
  if (message.type === 'error') console.error('server:', message.message);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error(`can't connect to ${server}/live/ingest — is the splat server running?`));
});
ws.send(encodeIngest({ type: 'hello', session, mode: 'features', device: `replay of ${info.device ?? 'a capture'}` }));
console.log(`Replaying ${frames.length} frames as live session ${session}; watch ${server.replace(/^ws/, 'http')}/live`);

const POSES_PER_FRAME = Math.max(1, Math.round(15 / fps));
let t = 0;
for (let f = 0; f < frames.length; f++) {
  const frame = frames[f];
  const pose = columnMajor(frame.transform_matrix);
  const intrinsics = { fx: frame.fl_x, fy: frame.fl_y, cx: frame.cx, cy: frame.cy, width: frame.w, height: frame.h };
  const jpeg = new Uint8Array(await Bun.file(path.join(dir, frame.file_path)).arrayBuffer());
  const anchors = visibleSeed(pose, scaleIntrinsics(intrinsics, 256, 192));
  ws.send(encodeIngest({ type: 'keyframe', seq: f, t, pose, intrinsics, anchors, jpegBytes: jpeg.byteLength }, jpeg));
  const next = frames[f + 1] ? columnMajor(frames[f + 1].transform_matrix) : pose;
  for (let p = 0; p < POSES_PER_FRAME; p++) {
    t += 1 / (fps * POSES_PER_FRAME);
    ws.send(encodeIngest({ type: 'pose', t, pose: between(pose, next, p / POSES_PER_FRAME) }));
    await Bun.sleep(1000 / (fps * POSES_PER_FRAME));
  }
}
// Let the server finish the last keyframe before hanging up.
const done = () => latest.stats && latest.stats.fused + latest.stats.skipped >= latest.stats.received;
for (let i = 0; i < 50 && !done(); i++) await Bun.sleep(100);
const stats = latest.stats;
console.log(
  stats
    ? `Fused ${stats.fused}, skipped ${stats.skipped}${stats.lastSkip ? ` (${stats.lastSkip})` : ''}; ${stats.voxels.toLocaleString()} points`
    : 'No stats from the server.',
);
ws.close();
