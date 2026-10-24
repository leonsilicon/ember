import { existsSync } from 'node:fs';
import path from 'node:path';

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
};

const SERVER_DIR = path.resolve(import.meta.dir, '..');

function int(value: string | undefined, fallback: number) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function findBrush(env: Record<string, string | undefined>): string | null {
  if (env.BRUSH_BIN) return env.BRUSH_BIN;
  const local = path.join(SERVER_DIR, 'bin', 'brush_app');
  if (existsSync(local)) return local;
  return Bun.which('brush_app');
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const steps = int(env.SPLAT_STEPS, 5000);
  return {
    port: int(env.SPLAT_PORT, 8899),
    host: env.SPLAT_HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.SPLAT_DATA_DIR ?? path.join(SERVER_DIR, 'data')),
    brushBin: findBrush(env),
    steps,
    // A snapshot every ~10% of training, so the viewer fills in while it trains.
    exportEvery: int(env.SPLAT_EXPORT_EVERY, Math.max(100, Math.round(steps / 10))),
    maxResolution: int(env.SPLAT_MAX_RESOLUTION, 960),
    shDegree: int(env.SPLAT_SH_DEGREE, 1),
    growthFraction: Number(env.SPLAT_GROWTH) || 0.5,
    maxSplats: int(env.SPLAT_MAX_SPLATS, 600_000),
  };
}
