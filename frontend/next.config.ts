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
  // The dashboard became the tab bar on every tool; its old links land on the first tab.
  redirects: async () => [{ source: '/dashboard', destination: '/control', permanent: true }],
};

export default config;
