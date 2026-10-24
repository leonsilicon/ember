/**
 * Camera geometry for the live reconstruction, in ARKit's conventions (see SPLATS.md): the world
 * is metres, gravity-aligned with +y up; a camera looks down −z with +x right and +y up; pixels
 * have their origin at the top-left with +v down. Poses are camera-to-world 4×4 matrices stored
 * column-major (16 numbers), the memory layout of both simd_float4x4 and three.js's Matrix4.
 */

export type Mat4 = ArrayLike<number>;

/** Pinhole intrinsics in pixels of a width×height image. */
export type Intrinsics = { fx: number; fy: number; cx: number; cy: number; width: number; height: number };

/** A point with known metric depth, at pixel (u, v) of a depth grid. */
export type Anchor = { u: number; v: number; depth: number; /** Which input point it is. */ index?: number };

export function scaleIntrinsics(k: Intrinsics, width: number, height: number): Intrinsics {
  const sx = width / k.width;
  const sy = height / k.height;
  return { fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy, width, height };
}

/** World-to-camera for a rigid camera-to-world pose (rotation transposed, translation undone). */
export function rigidInverse(m: Mat4): Float64Array {
  const out = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
    out[12 + r] = -(m[r * 4] * m[12] + m[r * 4 + 1] * m[13] + m[r * 4 + 2] * m[14]);
  }
  out[15] = 1;
  return out;
}

/**
 * World points (flat x, y, z) as anchors in a width×height grid of the camera: those in front
 * of it and inside the image.
 */
export function anchorsInView(points: ArrayLike<number>, pose: Mat4, k: Intrinsics): Anchor[] {
  const w2c = rigidInverse(pose);
  const anchors: Anchor[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const [x, y, z] = [points[i], points[i + 1], points[i + 2]];
    const camX = w2c[0] * x + w2c[4] * y + w2c[8] * z + w2c[12];
    const camY = w2c[1] * x + w2c[5] * y + w2c[9] * z + w2c[13];
    const depth = -(w2c[2] * x + w2c[6] * y + w2c[10] * z + w2c[14]);
    if (!(depth > 0.05)) continue;
    const u = k.cx + (k.fx * camX) / depth;
    const v = k.cy - (k.fy * camY) / depth;
    if (u >= 0 && u < k.width && v >= 0 && v < k.height) anchors.push({ u, v, depth, index: i / 3 });
  }
  return anchors;
}

/** Bilinear sample of a row-major grid at pixel position (u, v) (pixel centres at +0.5). */
export function sampleGrid(grid: Float32Array, width: number, height: number, u: number, v: number) {
  const fx = Math.min(Math.max(u - 0.5, 0), width - 1);
  const fy = Math.min(Math.max(v - 0.5, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = grid[y0 * width + x0] * (1 - tx) + grid[y0 * width + x1] * tx;
  const bottom = grid[y1 * width + x0] * (1 - tx) + grid[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Inverse depth ≈ scale · disparity + shift, fitted to a frame's anchors. */
export type DisparityFit = {
  scale: number;
  shift: number;
  /** Anchors offered, and how many of them the fit explains to within INLIER_ERROR. */
  anchors: number;
  inliers: number;
  /** Median relative depth error over the inliers. */
  medianError: number;
};

/** An anchor agrees with a fit when their depths differ by less than this fraction. */
const INLIER_ERROR = 0.1;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : NaN;
}

/** Small deterministic PRNG, so a fit is reproducible. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/**
 * Fits a monocular model's relative inverse depth to metric anchors (ARKit's feature points).
 * Depth Anything predicts inverse depth up to an unknown scale and shift per image, so solve
 * 1/depth ≈ s·d + t. ARKit's raw feature points are noisy and some are wrong outright (a fresh
 * point not yet triangulated, or one past an object's edge), so RANSAC over pairs of anchors
 * finds the fit most of them agree with, then a reweighted least-squares pass refines it.
 * Returns null when too few anchors agree on any fit; such a frame should be skipped.
 */
export function fitDisparity(
  disparity: Float32Array,
  width: number,
  height: number,
  anchors: Anchor[],
  options: { minAnchors?: number; minInlierRatio?: number } = {},
): DisparityFit | null {
  const minAnchors = options.minAnchors ?? 8;
  const minInlierRatio = options.minInlierRatio ?? 0.35;
  const n = anchors.length;
  if (n < minAnchors) return null;
  const d = anchors.map((a) => sampleGrid(disparity, width, height, a.u, a.v));
  const z = anchors.map((a) => a.depth);
  // Relative depth error of anchor i under (s, t), using inverse depth: |(s·d + t)·z − 1|.
  const residual = (s: number, t: number, i: number) => Math.abs((s * d[i] + t) * z[i] - 1);

  let best = { s: NaN, t: NaN, inliers: -1, cost: Infinity };
  const next = random(n * 7919 + Math.round(d[0] * 1e6));
  for (let iteration = 0; iteration < 300; iteration++) {
    const i = Math.floor(next() * n);
    const j = Math.floor(next() * n);
    if (Math.abs(d[i] - d[j]) < 0.02) continue;
    const s = (1 / z[i] - 1 / z[j]) / (d[i] - d[j]);
    const t = 1 / z[i] - s * d[i];
    if (!(s > 0)) continue;
    let inliers = 0;
    let cost = 0;
    for (let k = 0; k < n; k++) {
      const r = residual(s, t, k);
      if (r < INLIER_ERROR) inliers++;
      cost += Math.min(r, INLIER_ERROR);
    }
    if (inliers > best.inliers || (inliers === best.inliers && cost < best.cost)) best = { s, t, inliers, cost };
  }
  if (best.inliers < 2) return null;

  // Refine with weighted least squares, starting from RANSAC's inliers. Each anchor is weighted
  // by depth² so it counts by its relative error rather than letting near points dominate.
  let { s: scale, t: shift } = best;
  let weights: number[] = z.map((_, i) => (residual(scale, shift, i) < INLIER_ERROR ? 1 : 0));
  for (let iteration = 0; iteration < 5; iteration++) {
    let sw = 0, swd = 0, swdd = 0, swi = 0, swdi = 0;
    for (let i = 0; i < n; i++) {
      const w = weights[i] * z[i] ** 2;
      const inv = 1 / z[i];
      sw += w;
      swd += w * d[i];
      swdd += w * d[i] * d[i];
      swi += w * inv;
      swdi += w * d[i] * inv;
    }
    const det = sw * swdd - swd * swd;
    if (!(Math.abs(det) > 1e-12 * sw * sw)) break;
    const s = (sw * swdi - swd * swi) / det;
    if (!(s > 0)) break;
    scale = s;
    shift = (swdd * swi - swd * swdi) / det;
    // Tukey's biweight, with its cut-off at the inlier threshold.
    weights = z.map((_, i) => {
      const r = residual(scale, shift, i) / (2 * INLIER_ERROR);
      return r < 1 ? (1 - r * r) ** 2 : 0;
    });
  }

  const errors = z.map((_, i) => {
    const predicted = 1 / (scale * d[i] + shift);
    return predicted > 0 ? Math.abs(predicted - z[i]) / z[i] : Infinity;
  });
  const inlierErrors = errors.filter((e) => e < INLIER_ERROR);
  const inliers = inlierErrors.length;
  if (inliers < Math.max(minAnchors, n * minInlierRatio)) return null;
  return { scale, shift, anchors: n, inliers, medianError: median(inlierErrors) };
}

/** Metric depth from a fitted disparity map; NaN where the fit puts a pixel past maxDepth. */
export function depthFromDisparity(disparity: Float32Array, fit: DisparityFit, maxDepth: number) {
  const out = new Float32Array(disparity.length);
  for (let i = 0; i < disparity.length; i++) {
    const inverse = fit.scale * disparity[i] + fit.shift;
    out[i] = inverse > 1 / maxDepth ? 1 / inverse : NaN;
  }
  return out;
}
