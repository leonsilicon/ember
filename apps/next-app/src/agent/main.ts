#!/usr/bin/env bun
/**
 * The splat server's Mac agent: `bun run agent` in apps/next-app (or `vpx _dev`). It needs the app's
 * REDIS_URL and BLOB_READ_WRITE_TOKEN, which `vercel env pull .env.local` writes here and Bun
 * loads. Brush and the depth worker are found as before (see config.ts).
 */
import { redisUrl } from '../bus';
import { configFromEnv } from '../config';
import { startAgent } from './agent';
import { blobStorage } from './storage';

const config = configFromEnv();
const agent = await startAgent({ config, redisUrl: redisUrl(), storage: blobStorage });

console.log(`Splat agent: waiting for captures and live sessions (Redis prefix ${agent.keys.jobs.replace(/jobs$/, '')})`);
console.log(
  config.brushBin
    ? `Brush: ${config.brushBin} · ${config.steps} steps @ ${config.maxResolution}px, snapshot every ${config.exportEvery}`
    : 'Brush not found — run apps/next-app/scripts/install-brush.sh (or set BRUSH_BIN); captures will fail to train.',
);
console.log(
  config.depthWorkerBin && config.depthModel
    ? `Depth worker: ${config.depthWorkerBin} · voxels ${config.live.voxelSize * 100} cm, up to ${config.live.maxDepth} m`
    : 'Depth worker not found — run apps/next-app/scripts/install-depth.sh; live reconstruction will skip keyframes.',
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('Stopping (Brush is stopped; its capture trains again next time)…');
    await agent.stop();
    process.exit(0);
  });
}
