import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

import type { LiveConfig } from './live/hub';

export type ServerConfig = {
  port: number;
  host: string;
  /** Uploads, extracted datasets, Brush output and the job list live here. */
  dataDir: string;
  /** Path to Brush's `brush_app`, or null when it isn't installed. */
  brushBin: string | null;
  /** Brush settings. Live-ish defaults: a few minutes on an M2 Max (see README). */
  steps: number;
  exportEvery: number;
  maxResolution: number;
  shDegree: number;
  /**
   * Brush's --growth-select-fraction. Its default (0.1) is tuned for dense COLMAP seeds and
   * under-grows phone captures: a no-LiDAR iPhone 13 mini capture got 3.7k gaussians at 0.1
   * vs 110k at 0.5, and a LiDAR iPhone 17 Pro capture 36k vs 124k (visibly sharper).
   */
  growthFraction: number;
  /** Cap on gaussians, so a long capture's splat still loads in a phone browser (~100 B each). */
  maxSplats: number;
  /**
   * The live reconstruction's depth worker and its Core ML model (see install-depth.sh), or null
   * when they aren't installed. LiDAR phones need only the worker, for decoding their JPEGs.
   */
  depthWorkerBin: string | null;
  depthModel: string | null;
  live: LiveConfig;
};

const SERVER_DIR = path.resolve(import.meta.dirname, '..');

function int(value: string | undefined, fallback: number) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The first executable called `name` on the PATH, like `which`. */
function which(name: string, env: Record<string, string | undefined>) {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

export function findBrush(env: Record<string, string | undefined>, serverDir = SERVER_DIR): string | null {
  if (env.BRUSH_BIN) return env.BRUSH_BIN;
  const local = path.join(serverDir, 'bin', 'brush_app');
  if (existsSync(local)) return local;
  return which('brush_app', env);
}

function installed(envPath: string | undefined, local: string) {
  if (envPath) return envPath;
  return existsSync(local) ? local : null;
}

/** `serverDir` is this server's directory, where `data/`, `bin/` and `models/` are. */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
  serverDir = SERVER_DIR,
): ServerConfig {
  const steps = int(env.SPLAT_STEPS, 5000);
  return {
    port: int(env.SPLAT_PORT, 8899),
    host: env.SPLAT_HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.SPLAT_DATA_DIR ?? path.join(serverDir, 'data')),
    brushBin: findBrush(env, serverDir),
    steps,
    // A snapshot every ~10% of training, so the viewer fills in while it trains.
    exportEvery: int(env.SPLAT_EXPORT_EVERY, Math.max(100, Math.round(steps / 10))),
    maxResolution: int(env.SPLAT_MAX_RESOLUTION, 960),
    shDegree: int(env.SPLAT_SH_DEGREE, 1),
    growthFraction: Number(env.SPLAT_GROWTH) || 0.5,
    maxSplats: int(env.SPLAT_MAX_SPLATS, 600_000),
    depthWorkerBin: installed(env.DEPTH_WORKER_BIN, path.join(serverDir, 'bin', 'depth_worker')),
    depthModel: installed(env.DEPTH_MODEL, path.join(serverDir, 'models', 'DepthAnythingV2SmallF16.mlmodelc')),
    live: {
      voxelSize: Number(env.LIVE_VOXEL_SIZE) || 0.02,
      maxDepth: Number(env.LIVE_MAX_DEPTH) || 4,
      gridWidth: 256,
      gridHeight: 192,
    },
  };
}
