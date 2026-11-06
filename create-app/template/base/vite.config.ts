import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // `marcapony.json` uploads this directory as the app's static assets.
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    // `bun run dev` serves the Hono app on 8787; in production the platform
    // routes /api/* to the server instead (see routes.server in marcapony.json).
    proxy: { '/api': 'http://localhost:8787' },
  },
})
