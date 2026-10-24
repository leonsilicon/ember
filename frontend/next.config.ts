import type { NextConfig } from 'next';

const config: NextConfig = {
  // The live viewer's point shaders are .vert/.frag files, imported as strings.
  turbopack: {
    rules: {
      '*.vert': { type: 'raw' },
      '*.frag': { type: 'raw' },
    },
  },
  // ws (for upgradeWebSocket) and ioredis load optional native addons at runtime; leave them unbundled.
  serverExternalPackages: ['ws', 'ioredis', 'bonjour-service'],
};

export default config;
