import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outdir: 'dist',
  external: [
    'vscode',
    // Node builtins：sumi-edu (opensumi-web) 浏览器运行时由 OpenSumi sandbox-bridge 转发，
    // 在 fs/path 调用时通过 gateway 控制平面落到 sandbox Node 进程执行。
    // 本轮 (Task A) 先 external 化避免 esbuild 尝试打包内置模块；后续 Task B/C 将逐步替换为
    // vscode.workspace.fs / Uri.joinPath（参考 sumi-edu web 运行时契约）。
    'fs',
    'fs/promises',
    'path',
    'path/posix',
    'os',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:path/posix',
    'node:os',
  ],
  format: 'cjs',
  platform: 'browser',
  sourcemap: false,
  minify: true,
  keepNames: true,
  tsconfig: 'tsconfig.json',
})
