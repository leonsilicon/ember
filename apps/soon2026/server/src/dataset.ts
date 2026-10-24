import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

export type CaptureMode = 'lidar' | 'features' | 'unknown';

export type ExtractedCapture = {
  /** Directory holding transforms.json — what Brush is pointed at. */
  datasetDir: string;
  frames: number;
  mode: CaptureMode;
  seedPoints: number;
  /** World point a viewer should orbit around (see focusPoint). */
  focus: [number, number, number] | null;
};

export class DatasetError extends Error {}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new DatasetError(`${cmd[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

/** True for archive paths that would land outside the extraction directory. */
export function isUnsafeEntry(entry: string) {
  return path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..');
}

async function findTransforms(dir: string, depth = 0): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === 'transforms.json')) return dir;
  if (depth >= 3) return null;
  for (const e of entries) {
    if (e.isDirectory() && e.name !== '__MACOSX') {
      const found = await findTransforms(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Unpacks an uploaded capture zip and checks it is a dataset Brush can train on. */
export async function extractCapture(zipPath: string, destDir: string): Promise<ExtractedCapture> {
  const entries = (await run(['unzip', '-Z1', zipPath])).split('\n').filter(Boolean);
  const unsafe = entries.find(isUnsafeEntry);
  if (unsafe) throw new DatasetError(`archive entry escapes the dataset: ${unsafe}`);
  await mkdir(destDir, { recursive: true });
  await run(['unzip', '-q', '-o', zipPath, '-d', destDir]);

  const datasetDir = await findTransforms(destDir);
  if (!datasetDir) throw new DatasetError('no transforms.json in the upload');

  const transforms = await Bun.file(path.join(datasetDir, 'transforms.json')).json();
  const frames: (Frame & { file_path?: unknown })[] = Array.isArray(transforms.frames) ? transforms.frames : [];
  if (frames.length === 0) throw new DatasetError('transforms.json has no frames');
  for (const frame of frames) {
    if (typeof frame.file_path !== 'string' || isUnsafeEntry(frame.file_path)) {
      throw new DatasetError(`bad frame path: ${String(frame.file_path)}`);
    }
    if (!(await Bun.file(path.join(datasetDir, frame.file_path)).exists())) {
      throw new DatasetError(`missing image ${frame.file_path}`);
    }
  }

  const infoFile = Bun.file(path.join(datasetDir, 'capture.json'));
  const info = (await infoFile.exists()) ? await infoFile.json() : {};
  const mode: CaptureMode = info.mode === 'lidar' || info.mode === 'features' ? info.mode : 'unknown';
  const plyFile = typeof transforms.ply_file_path === 'string' && !isUnsafeEntry(transforms.ply_file_path)
    ? transforms.ply_file_path
    : undefined;
  return {
    datasetDir,
    frames: frames.length,
    mode,
    seedPoints: typeof info.points === 'number' ? info.points : 0,
    focus: await focusPoint(datasetDir, frames[0], plyFile).catch(() => null),
  };
}

/** Byte sizes of PLY property types. */
const PLY_TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

/** x/y/z (float32) of every vertex in a binary little-endian PLY, or null for anything else. */
async function readPlyPositions(file: string): Promise<Float64Array | null> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const headerEnd = Buffer.from(bytes).indexOf('end_header\n');
  if (headerEnd < 0) return null;
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)).split('\n');
  if (!header.includes('format binary_little_endian 1.0')) return null;
  const count = Number(header.find((l) => l.startsWith('element vertex'))?.split(' ')[2] ?? NaN);
  const offsets: Record<string, number> = {};
  let stride = 0;
  const types: Record<string, string> = {};
  for (const line of header.filter((l) => l.startsWith('property '))) {
    const [, type, name] = line.split(' ');
    const size = PLY_TYPE_SIZE[type];
    if (!size) return null;
    offsets[name] = stride;
    types[name] = type;
    stride += size;
  }
  if (!Number.isFinite(count) || !['x', 'y', 'z'].every((k) => types[k] === 'float' || types[k] === 'float32')) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd + 'end_header\n'.length);
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count && (i + 1) * stride <= view.byteLength; i++) {
    out[i * 3] = view.getFloat32(i * stride + offsets.x, true);
    out[i * 3 + 1] = view.getFloat32(i * stride + offsets.y, true);
    out[i * 3 + 2] = view.getFloat32(i * stride + offsets.z, true);
  }
  return out;
}

type Frame = { transform_matrix: number[][]; fl_x?: number; fl_y?: number; cx?: number; cy?: number; w?: number; h?: number };

/**
 * Where a viewer should orbit: the point straight ahead of the first camera at the median
 * depth of the seed points it sees. Null when there aren't enough seed points to tell.
 */
export async function focusPoint(datasetDir: string, frame: Frame, plyFile: string | undefined) {
  if (!plyFile) return null;
  const ply = path.join(datasetDir, plyFile);
  if (!(await Bun.file(ply).exists())) return null;
  const points = await readPlyPositions(ply);
  const m = frame.transform_matrix;
  const { fl_x: fx, fl_y: fy, cx, cy, w, h } = frame;
  if (!points || !fx || !fy || cx === undefined || cy === undefined || !w || !h) return null;
  const pos = [m[0][3], m[1][3], m[2][3]];
  const right = [m[0][0], m[1][0], m[2][0]];
  const up = [m[0][1], m[1][1], m[2][1]];
  const forward = [-m[0][2], -m[1][2], -m[2][2]];
  const depths: number[] = [];
  for (let i = 0; i < points.length; i += 3) {
    const d = [points[i] - pos[0], points[i + 1] - pos[1], points[i + 2] - pos[2]];
    const z = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
    if (z < 0.1) continue;
    const u = cx + (fx * (d[0] * right[0] + d[1] * right[1] + d[2] * right[2])) / z;
    const v = cy - (fy * (d[0] * up[0] + d[1] * up[1] + d[2] * up[2])) / z;
    if (u >= 0 && u < w && v >= 0 && v < h) depths.push(z);
  }
  if (depths.length < 20) return null;
  depths.sort((a, b) => a - b);
  const depth = Math.min(10, Math.max(0.3, depths[depths.length >> 1]));
  return pos.map((p, k) => p + forward[k] * depth) as [number, number, number];
}

/** Reads the vertex count from a PLY header, or null if the file isn't a PLY. */
export async function plyVertexCount(file: string): Promise<number | null> {
  const head = await Bun.file(file).slice(0, 4096).text();
  if (!head.startsWith('ply')) return null;
  const match = /element vertex (\d+)/.exec(head);
  return match ? Number(match[1]) : null;
}
