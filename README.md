# AI 工作台

浏览器端可交互工作台（**本地模式**）：**opensumi/codeblitz 全局交互容器**（explorer / 编辑器 / 终端 / 聊天 / 扩展）+ **opencode 直连后端**（AI + 终端 PTY + 文件系统）+ **registry 扩展分发**。

`npx github:weizuxiao911/magicbook` 一行启动整套。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│ 浏览器 (client/ + extensions/)                           │
│   - opensumi/codeblitz 容器 (explorer/编辑器/终端/聊天) │
│   - SDK 直连 opencode (无中间代理, 无中间层抽象)      │
│   - 写操作走单例 PTY (FsPty, 跨平台 shell-ops)          │
│   - 读操作走 opencode 全局 API (/api/fs/* /find/file)    │
└────────────────────┬────────────────────────────────────┘
                     │ WebSocket / fetch
                     │ (APP_BASE_URL, 单一事实源)
┌────────────────────▼────────────────────────────────────┐
│ opencode serve (3100, 默认)                              │
│   - /api/fs/{list,read,find}    全局只读 API            │
│   - /api/pty / WS                终端 + 单例 PTY 通道    │
│   - /path                        宿主 cwd + home        │
│   - /session/{id}/shell          仅给 chat agent 工具调 │
└─────────────────────────────────────────────────────────┘

registry (7790, HTTPS) — vsix 扩展分发 (独立服务)
```

**关键变化（vs 旧架构）**:
- ❌ 旧: client → 中间层(:7789, /ai /fs /workspace) → opencode(:24096) 三层
- ✅ 新: client → opencode(:3100) 直连, cli 是进程编排器
- ❌ 旧: 中间层 HTTP 路由实现 /fs
- ✅ 新: 写操作走 FsPty 单例 PTY, 读操作走 opencode 全局 API
- ❌ 旧: 中间层抽象 (singleton / runtime / 等)
- ✅ 新: 单一事实源 (cli's --port → process.env → webpack 注入)

## 快速开始

```bash
# 方式 1: npx (推荐, 一行启动, 自动装依赖)
npx github:weizuxiao911/magicbook              # 默认 :3100 + :7788
npx github:weizuxiao911/magicbook --port 4000  # opencode 4000
npx github:weizuxiao911/magicbook --client-port 8000  # webpack 8000

# 方式 2: git clone + npm install (本地开发)
git clone https://github.com/weizuxiao911/magicbook
cd magicbook
npm install
npm run dev                # cli web 模式 (opencode 3100 + client 7788)
npm run serve              # 只起 opencode (无 client)
```

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 工作台 | http://localhost:7788 (默认) | 浏览器打开; 端口可由 `--client-port` 改 |
| opencode | http://127.0.0.1:3100 (默认) | AI + 终端 + 文件系统; 端口由 `--port` 改 |
| registry | https://127.0.0.1:7790 | 扩展分发（自签; 单独 `cd registry && npm run dev`） |

## 端口与配置（单一事实源: cli）

```bash
cli --port <N>             # opencode 端口 (默认 3100)
cli --client-port <N>      # webpack-dev-server 端口 (默认 7788)
cli --hostname <host>      # opencode 绑定地址 (默认 127.0.0.1)
# CORS auto-derived: http://<hostname>:<client-port>
```

cli 启动时把 `--port` 通过 `process.env.APP_BASE_URL` 注入 webpack, webpack 编译期 `__APP_BASE_URL__` 注入前端 bundle. 客户端 SDK 直连, 无 CORS 配置散落.

`client/.env.development` 是直跑 `cd client && npm run dev` 的兜底（不走 cli 时）:

```bash
APP_BASE_URL=http://127.0.0.1:3100   # 跟 cli --port 一致
REGISTRY_BASE_URL=https://127.0.0.1:7790
```

## 扩展开发与分发

1. **写扩展源码**：`extensions/<name>/`（**一律 TypeScript**：`src/extension.ts` 入口 + esbuild 编译到 `dist/`；**必须声明 `browser` 字段**（浏览器扩展，无 node 依赖）；**publisher 统一 `weizuxiao911`**）
   - **webview 单独维护**：扩展若有 webview UI，放 `webview/` 目录（或 `webview.tsx`），不内联拼 HTML 字符串
   - HTML 预览示例：`extensions/html-preview/`（TS + `src/extension.ts`，customEditor `*.html` → webview 直接运行文件内容，支持 JS 执行）
   - 试卷预览示例：`extensions/paper/`（TS + `webview/` vite 构建，customEditor `*.paper`）
2. **打包**：在扩展目录 `npx @vscode/vsce package --allow-missing-repository`
   - vsix 文件名规范 `{发布者}.{拓展名称}-{版本}.vsix`（vsce 默认生成，如 `weizuxiao911.magicbook-html-preview-0.1.0.vsix`）
3. **分发**：把 `.vsix` 放入 `registry/vsix/`，然后：

```bash
cd registry
npm run build     # 扫描 vsix → 解压 dist/<id>/ + 生成 metadata.json
npm run serve     # HTTPS 分发（:7790）
```

4. **客户端加载**：刷新工作台 → 打开匹配文件（如 `demo.html` / `demo.paper`）→ customEditor 激活 → 预览。

> 扩展激活链路：metadata → 打开文件触发 `onCustomEditor:<viewType>` → 拉取 `browser` 入口 → 注册 provider → resolve webview。
> 常见问题（FileType 常量 / 证书 / 控制帧过滤 / __PAPER_MANIFEST__ 等）见 [`AGENTS.md`](./AGENTS.md) 的「常见问题与修复」速查表。

### 首次运行：信任 registry 证书

registry 用自签 HTTPS（kt-ext 协议强制 https），首次需要把证书加入系统钥匙串：

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /Users/weizuxiao/Documents/开源项目/workspace-dev/registry/certs/cert.pem
```

（证书已含 SAN：`localhost` 与 `127.0.0.1`；重新生成：见 `registry/` 说明）

## 目录

| 路径 | 职责 |
| --- | --- |
| `cli/` | 进程编排器：`bin/cli.cjs` npx 入口 + `src/main.ts` web/serve 路由; opencode 进程组管理 |
| `client/` | opensumi/codeblitz 容器 + 适配层（RemoteFS / 终端 / registry / 聊天）+ 登录 |
| `client/src/commands/` | 接口+Token 定义 (IAgent/IRegistry/IFileSystem/IEnvService/IAuth) |
| `client/src/config/` | 初始化 / 模块注册 / 布局 / runtime config |
| `client/src/service/` | 8 实现 (agent/auth/env/fs/fs-pty/registry/shell-ops/terminal) |
| `client/src/styles/` | CSS 覆盖 |
| `client/.env.development` | cli 不走时的兜底配置 |
| `extensions/` | vsix 扩展源码（html-preview / paper） |
| `registry/` | vsix 扩展分发（HTTPS，kt-ext；build → metadata.json + 静态资源） |

## License

MIT
