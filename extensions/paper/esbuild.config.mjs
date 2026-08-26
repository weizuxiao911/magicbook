import * as esbuild from 'esbuild'

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
})
