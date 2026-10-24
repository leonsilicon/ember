import { rigidInverse, type Anchor, type Intrinsics, type Mat4 } from './geometry';

export type IntegrateOptions = {
  minDepth: number;
  maxDepth: number;
  /**
   * Drop pixels on depth edges: where depth within 2 pixels varies by more than this fraction.
   * Monocular depth blurs object boundaries into ramps, and unprojecting those leaves streaks of
   * "flying pixels" between the object and whatever is behind it.
   */
  edgeThreshold: number;
  /** Ignore this many pixels at the image border, where depth models are least reliable. */
  border: number;
};

export const DEFAULT_INTEGRATE: IntegrateOptions = { minDepth: 0.15, maxDepth: 4, edgeThreshold: 0.06, border: 2 };

// 17 bits per axis (±65k voxels, ±1.3 km at 2 cm) keeps the packed key under 2^53.
const AXIS = 1 << 17;
const HALF = AXIS / 2;
/** A running mean stops at this many samples, so a surface can still settle as views improve. */
const SAMPLE_CAP = 64;

/**
 * The reconstruction: coloured points on a voxel grid. Each voxel keeps the running mean of the
 * samples that fell in it, and how many keyframes saw it, which the viewer uses as confidence.
 * Voxels are only ever appended, so a voxel's index is stable and viewers can be sent updates.
 */
export class VoxelCloud {
  count = 0;
  positions: Float32Array;
  colors: Float32Array;
  samples: Uint16Array;
  views: Uint16Array;
  private lastFrame: Int32Array;
  private index = new Map<number, number>();
  private frame = 0;

  constructor(
    readonly voxelSize: number,
    readonly maxVoxels = 4_000_000,
    capacity = 1 << 16,
  ) {
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.samples = new Uint16Array(capacity);
    this.views = new Uint16Array(capacity);
    this.lastFrame = new Int32Array(capacity).fill(-1);
  }

  get full() {
    return this.count >= this.maxVoxels;
  }

  private grow() {
    const capacity = Math.min(this.positions.length / 3 * 2, this.maxVoxels);
    const resize = <T extends Float32Array | Uint16Array | Int32Array>(array: T, size: number): T => {
      const next = new (array.constructor as new (n: number) => T)(size);
      next.set(array);
      return next;
    };
    this.positions = resize(this.positions, capacity * 3);
    this.colors = resize(this.colors, capacity * 3);
    this.samples = resize(this.samples, capacity);
    this.views = resize(this.views, capacity);
    const lastFrame = resize(this.lastFrame, capacity);
    lastFrame.fill(-1, this.lastFrame.length);
    this.lastFrame = lastFrame;
  }

  private key(x: number, y: number, z: number) {
    const s = this.voxelSize;
    const ix = Math.floor(x / s) + HALF;
    const iy = Math.floor(y / s) + HALF;
    const iz = Math.floor(z / s) + HALF;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= AXIS || iy >= AXIS || iz >= AXIS) return -1;
    return (ix * AXIS + iy) * AXIS + iz;
  }

  /** Adds one sample. Returns the voxel's index if this is the first sample it got this frame. */
  private add(x: number, y: number, z: number, r: number, g: number, b: number): number {
    const key = this.key(x, y, z);
    if (key < 0) return -1;
    let i = this.index.get(key);
    if (i === undefined) {
      if (this.full) return -1;
      if (this.count === this.samples.length) this.grow();
      i = this.count++;
      this.index.set(key, i);
    }
    const n = Math.min(this.samples[i] + 1, SAMPLE_CAP);
    this.samples[i] = n;
    const p = i * 3;
    this.positions[p] += (x - this.positions[p]) / n;
    this.positions[p + 1] += (y - this.positions[p + 1]) / n;
    this.positions[p + 2] += (z - this.positions[p + 2]) / n;
    this.colors[p] += (r - this.colors[p]) / n;
    this.colors[p + 1] += (g - this.colors[p + 1]) / n;
    this.colors[p + 2] += (b - this.colors[p + 2]) / n;
    if (this.lastFrame[i] === this.frame) return -1;
    this.lastFrame[i] = this.frame;
    if (this.views[i] < 0xffff) this.views[i]++;
    return i;
  }

  /**
   * Unprojects a metric depth map (NaN = no depth) with its colours into the cloud, and returns
   * the voxels it touched.
   */
  integrate(
    depth: Float32Array,
    rgb: Uint8Array,
    width: number,
    height: number,
    k: Intrinsics,
    pose: Mat4,
    options: IntegrateOptions = DEFAULT_INTEGRATE,
  ): number[] {
    this.frame++;
    const touched: number[] = [];
    const edges = depthEdges(depth, width, height, options.edgeThreshold);
    const { minDepth, maxDepth, border } = options;
    for (let v = border; v < height - border; v++) {
      for (let u = border; u < width - border; u++) {
        const i = v * width + u;
        const z = depth[i];
        if (!(z >= minDepth && z <= maxDepth) || edges[i]) continue;
        // Camera space (+y up, looking down −z), then to the world.
        const cx = ((u + 0.5 - k.cx) / k.fx) * z;
        const cy = (-(v + 0.5 - k.cy) / k.fy) * z;
        const cz = -z;
        const x = pose[0] * cx + pose[4] * cy + pose[8] * cz + pose[12];
        const y = pose[1] * cx + pose[5] * cy + pose[9] * cz + pose[13];
        const w = pose[2] * cx + pose[6] * cy + pose[10] * cz + pose[14];
        const index = this.add(x, y, w, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        if (index >= 0) touched.push(index);
      }
    }
    return touched;
  }

  /**
   * What the cloud already says about a new frame: the voxels it would see, as anchors in its
   * width×height grid, keeping the nearest per cell of a coarse screen grid so that surfaces
   * hidden behind others don't count. Only voxels at least `minViews` keyframes agreed on.
   */
  anchorsInView(pose: Mat4, k: Intrinsics, options: { minViews: number; maxDepth: number; cells?: number }): Anchor[] {
    const { minViews, maxDepth, cells = 32 } = options;
    const w2c = rigidInverse(pose);
    const cellsY = Math.max(1, Math.round((cells * k.height) / k.width));
    const nearest = new Map<number, Anchor>();
    for (let i = 0; i < this.count; i++) {
      if (this.views[i] < minViews) continue;
      const x = this.positions[i * 3];
      const y = this.positions[i * 3 + 1];
      const z = this.positions[i * 3 + 2];
      const depth = -(w2c[2] * x + w2c[6] * y + w2c[10] * z + w2c[14]);
      if (!(depth > 0.1 && depth < maxDepth)) continue;
      const u = k.cx + (k.fx * (w2c[0] * x + w2c[4] * y + w2c[8] * z + w2c[12])) / depth;
      const v = k.cy - (k.fy * (w2c[1] * x + w2c[5] * y + w2c[9] * z + w2c[13])) / depth;
      if (!(u >= 0 && u < k.width && v >= 0 && v < k.height)) continue;
      const cell = Math.floor((v / k.height) * cellsY) * cells + Math.floor((u / k.width) * cells);
      const best = nearest.get(cell);
      if (!best || depth < best.depth) nearest.set(cell, { u, v, depth, index: i });
    }
    return [...nearest.values()];
  }

  /**
   * Voxels seen by at least `minViews` keyframes as a binary PLY (float x/y/z, uchar r/g/b), the
   * same layout as a capture's points.ply, so it opens in MeshLab, Blender or a splat trainer.
   */
  toPly(minViews = 1) {
    const kept: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.views[i] >= minViews) kept.push(i);
    const header = new TextEncoder().encode(
      'ply\nformat binary_little_endian 1.0\ncomment soon2026 live reconstruction\n' +
        `element vertex ${kept.length}\nproperty float x\nproperty float y\nproperty float z\n` +
        'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n',
    );
    const out = new Uint8Array(header.byteLength + kept.length * 15);
    out.set(header);
    const view = new DataView(out.buffer, header.byteLength);
    kept.forEach((i, j) => {
      for (let a = 0; a < 3; a++) {
        view.setFloat32(j * 15 + a * 4, this.positions[i * 3 + a], true);
        view.setUint8(j * 15 + 12 + a, Math.round(this.colors[i * 3 + a]));
      }
    });
    return out;
  }
}

/**
 * Marks pixels whose 5×5 neighbourhood spans a depth range wider than `threshold` × its nearest
 * depth (or has a hole in it). Separable min/max filters keep it linear in the pixel count.
 */
export function depthEdges(depth: Float32Array, width: number, height: number, threshold: number, radius = 2) {
  const n = width * height;
  const rowMin = new Float32Array(n);
  const rowMax = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = Math.min(Math.max(x + dx, 0), width - 1);
        const z = depth[y * width + xx];
        // A hole (NaN) next to a pixel counts as an edge.
        if (!(z > 0)) {
          lo = -Infinity;
          break;
        }
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      }
      rowMin[y * width + x] = lo;
      rowMax[y * width + x] = hi;
    }
  }
  const edges = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const i = Math.min(Math.max(y + dy, 0), height - 1) * width + x;
        if (rowMin[i] < lo) lo = rowMin[i];
        if (rowMax[i] > hi) hi = rowMax[i];
      }
      if (!(lo > 0) || hi - lo > threshold * lo) edges[y * width + x] = 1;
    }
  }
  return edges;
}
