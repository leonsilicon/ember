import { networkInterfaces } from 'node:os';

import { createApp } from './src/app';
import { configFromEnv } from './src/config';

const config = configFromEnv();
const app = await createApp(config);

Bun.serve({
  port: config.port,
  hostname: config.host,
  // Captures are a few hundred MB of JPEGs; Bun's default cap is 128 MB.
  maxRequestBodySize: 4 * 1024 ** 3,
  idleTimeout: 255,
  fetch: app.fetch,
});

const lan = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
console.log(`Splat server  http://localhost:${config.port}/   (phone: http://${lan ?? '<this-mac-ip>'}:${config.port})`);
console.log(
  config.brushBin
    ? `Brush: ${config.brushBin} · ${config.steps} steps @ ${config.maxResolution}px, snapshot every ${config.exportEvery}`
    : 'Brush not found — run server/scripts/install-brush.sh (or set BRUSH_BIN); uploads will fail to train.',
);
