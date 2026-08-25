import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const manifestPath = path.resolve('webview/dist/.vite/manifest.json')
const manifest = fs.readFileSync(manifestPath, 'utf-8')

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  minify: true,
  keepNames: true,
  tsconfig: 'tsconfig.json',
  define: {
    __PAPER_MANIFEST__: JSON.stringify(manifest),
  },
})
