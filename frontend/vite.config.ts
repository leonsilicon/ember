import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

// The rover's brain lives in the Expo app (owned there, read-only here); the simulator imports it as-is.
const roverBrainDir = fileURLToPath(new URL('../apps/expo-app/src/lib/rover-brain', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@rover-brain': `${roverBrainDir}/index.ts` },
  },
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), roverBrainDir] },
  },
})
