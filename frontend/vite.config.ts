import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { phoneDiscovery } from './phone-discovery.ts'

// The rover's brain lives in the Expo app (owned there, read-only here); the simulator imports it as-is.
const roverBrainDir = fileURLToPath(new URL('../apps/expo-app/src/lib/rover-brain', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  // phoneDiscovery: finds the rover's iPhone on the Wi-Fi so its camera links up by itself (GET /api/phone-camera).
  plugins: [react(), tailwindcss(), phoneDiscovery()],
  resolve: {
    alias: { '@rover-brain': `${roverBrainDir}/index.ts` },
  },
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), roverBrainDir] },
  },
})
