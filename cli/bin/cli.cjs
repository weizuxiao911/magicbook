#!/usr/bin/env node
/**
 * cli — npx bin 入口
 *
 * 转发到 cli/src/main.ts (通过 tsx 执行); 默认子命令 web.
 *
 * 使用:
 *   npx github:user/repo            → 等价 web (默认 :3100 + :7788)
 *   npx github:user/repo web        → 启 client + opencode
 *   npx github:user/repo serve      → 只起 opencode
 *   npx github:user/repo --help     → 帮助
 *
 * 设计: npx 调起本文件 (package.json bin), 内部 spawn tsx 跑 cli/src/main.ts.
 *   不再依赖 npm --prefix 间接调, 少一层 fork, 冷启 -300ms.
 *
 * 默认 opencode 端口 3100 (匹配 client/.env.development 的 APP_BASE_URL);
 * CORS 默认 http://127.0.0.1:7788 (webpack-dev-server 默认地址). 用户可命令行覆盖.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');  // cli/bin → 项目根
const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(__dirname, '..', 'src', 'main.ts');  // cli/bin → cli/src/main.ts

const args = process.argv.slice(2);
if (args.length === 0) args.push('web'); // 默认 web 模式

// 解析 cli 自己的参数 (不传给 opencode)
let clientPort = '7788';
const cpIdx = args.indexOf('--client-port');
if (cpIdx >= 0 && args[cpIdx + 1]) {
  clientPort = args[cpIdx + 1];
  args.splice(cpIdx, 2);  // 移除, opencode 不识别
}

// 默认 opencode 参数
if (!args.includes('--port')) args.push('--port', '3100');
if (!args.includes('--hostname')) args.push('--hostname', '127.0.0.1');
// CORS 默认指向 client 端口
if (!args.includes('--cors')) args.push('--cors', `http://127.0.0.1:${clientPort}`);

// 单一事实源: cli's --port 决定 APP_BASE_URL, 通过 env var 注入到 webpack
// (webpack 优先读 process.env, 兜底 .env; 用户运行时改 --port 即可全局生效)
const portIdx = args.indexOf('--port');
const hostnameIdx = args.indexOf('--hostname');
const port = portIdx >= 0 && args[portIdx + 1] ? args[portIdx + 1] : '3100';
const hostname = hostnameIdx >= 0 && args[hostnameIdx + 1] ? args[hostnameIdx + 1] : '127.0.0.1';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || `http://${hostname}:${port}`;
// client 端口也通过 env var 传给 webpack-dev-server
process.env.CLIENT_PORT = clientPort;

const child = spawn(tsxBin, [cliEntry, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (e) => {
  console.error('[cli] 启动失败:', e.message);
  process.exit(1);
});
