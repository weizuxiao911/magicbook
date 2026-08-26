import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    // worker 1.3MB 内联为 data URL (?url import), webview 不走网络请求, 无 404
    assetsInlineLimit: 5 * 1024 * 1024,
  },
})
