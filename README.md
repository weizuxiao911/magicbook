# AI 工作台

浏览器端可交互工作台（C/S 架构）：**opensumi/codeblitz 全局交互容器**（explorer / 编辑器 / 终端 / 聊天 / 扩展）+ **服务端**（sandbox 调度 + opencode + registry）。

## 架构

```
浏览器 (client/)
  ├── 容器: opensumi/codeblitz（explorer / 编辑器 / 终端 / 聊天 / 扩展）
  ├── 适配层: RemoteFS（BrowserFS → /fs）、终端代理（→ /ai/pty）、registry（扩展元数据）
  └── 唯一配置入口: APP_BASE_URL（.env.development, 编译期注入）

服务端 (sandbox/)
  ├── :7789   入口 — /ai 反向代理（→ opencode :24096）、/fs 文件系统、/workspace 调度、
  │            /sandbox 信息接口（baseurl + 默认 shell + 连接状态）、/health
  ├── opencode :24096  AI + 终端 PTY（/pty, node-pty; sandbox 探活/自启, 非默认启动）
  └── registry :7781  vsix 扩展分发（HTTPS, kt-ext 协议; metadata.json + 静态资源）
```

下游服务地址**全部由 `APP_BASE_URL` 派生**（不配置第二个地址）：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| opencode（AI/聊天） | `${APP_BASE_URL}/ai` | sandbox 全量透传（含 ws upgrade） |
| 终端 PTY | `${APP_BASE_URL}/ai/pty` | 同 opencode 址（sandbox 透传） |
| 文件系统 | `${APP_BASE_URL}/fs` | sandbox 内置实现（读写宿主文件系统） |
| 扩展分发 | `REGISTRY_BASE_URL` | 编译期独立配置（.env REGISTRY_BASE_URL） |

扩展源码在 `extensions/<name>/`，打包成 vsix 交给 registry 分发；client 经 metadata 拉取元数据，打开匹配文件（如 `.html` / `.paper`）时激活扩展（customEditor + webview）。

## 快速开始

```bash
npm install
npm run dev        # sandbox（tsx watch）+ client（webpack-dev-server）并发启动
```

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 工作台 | http://localhost:7788 | 浏览器打开 |
| sandbox | http://127.0.0.1:7789 | 统一入口（/ai /fs /workspace /sandbox） |
| opencode | http://127.0.0.1:24096 | AI + 终端（sandbox 自动拉起） |
| registry | https://127.0.0.1:7781 | 扩展分发（自签证书; 单独 `cd registry && npm run dev`） |

### 配置（.env.development）

```bash
APP_BASE_URL=http://127.0.0.1:7789   # 唯一入口, client 编译期注入
REGISTRY_BASE_URL=                   # 扩展分发地址（可选）
```

### 首次运行：信任 registry 证书

registry 用自签 HTTPS（kt-ext 协议强制 https），首次需要把证书加入系统钥匙串：

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /Users/weizuxiao/Documents/开源项目/workspace-dev/registry/certs/cert.pem
```

（证书已含 SAN：`localhost` 与 `127.0.0.1`；重新生成：见 `registry/` 说明）

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
npm run serve     # HTTPS 分发（:7781）
```

4. **客户端加载**：刷新工作台 → 打开匹配文件（如 `demo.html` / `demo.paper`）→ customEditor 激活 → 预览。

> 扩展激活链路：metadata → 打开文件触发 `onCustomEditor:<viewType>` → 拉取 `browser` 入口 → 注册 provider → resolve webview。
> 常见问题（FileType 常量 / 证书 / 控制帧过滤 / __PAPER_MANIFEST__ 等）见 [`AGENTS.md`](./AGENTS.md) 的「常见问题与修复」速查表。

## 目录

| 路径 | 职责 |
| --- | --- |
| `client/` | opensumi/codeblitz 容器 + 适配层（RemoteFS / 终端 / registry / 聊天）+ 登录 |
| `sandbox/` | 服务端统一入口（:7789）：/ai 透传、/fs 文件系统、/workspace 调度、/sandbox 信息、opencode 生命周期 |
| `registry/` | vsix 扩展分发（HTTPS，kt-ext；build → metadata.json + 静态资源） |
| `extensions/` | vsix 扩展源码（html-preview / paper） |

## License

MIT
