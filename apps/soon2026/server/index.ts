import { networkInterfaces } from 'node:os';

import { createApp } from './src/app';
import { configFromEnv } from './src/config';
import type { SocketData } from './src/live/hub';

const config = configFromEnv();
const app = await createApp(config);

Bun.serve<SocketData>({
  port: config.port,
  hostname: config.host,
  // Captures are a few hundred MB of JPEGs; Bun's default cap is 128 MB.
  maxRequestBodySize: 4 * 1024 ** 3,
  idleTimeout: 255,
  fetch(request, server) {
    // The live reconstruction's WebSockets (phone in, browsers out).
    if (app.live.upgrade(request, server)) return;
    return app.fetch(request);
  },
  websocket: app.live.websocket,
});

const lan = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
console.log(`Splat server  http://localhost:${config.port}/   (phone: http://${lan ?? '<this-mac-ip>'}:${config.port})`);
console.log(`Live 3D view  http://localhost:${config.port}/live`);
console.log(
  config.brushBin
    ? `Brush: ${config.brushBin} · ${config.steps} steps @ ${config.maxResolution}px, snapshot every ${config.exportEvery}`
    : 'Brush not found — run server/scripts/install-brush.sh (or set BRUSH_BIN); uploads will fail to train.',
);
console.log(
  config.depthWorkerBin && config.depthModel
    ? `Depth worker: ${config.depthWorkerBin} · voxels ${config.live.voxelSize * 100} cm, up to ${config.live.maxDepth} m`
    : 'Depth worker not found — run server/scripts/install-depth.sh; live reconstruction will skip keyframes.',
);
