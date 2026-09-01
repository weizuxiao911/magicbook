import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('cloudlab-ui')) {
              return 'cloudlab-ui-vendor'
            }
            if (id.includes('post-robot')) {
              return 'post-robot-vendor'
            }
            return 'vendor'
          }
          return undefined
        }
      }
    }
  }
})
