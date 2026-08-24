# Magicbook

浏览器端可交互工作台（C/S 架构）：**opensumi/codeblitz 全局交互容器**（explorer / 编辑器 / 终端 / 聊天）+ **服务端**（sandbox 调度 / fs / opencode / registry）。

## 架构

```
浏览器 (client/)
  ├── 容器: opensumi/codeblitz（explorer / 编辑器 / 终端 / 聊天 / 扩展）
  ├── 适配层: RemoteFS（BrowserFS → fs 服务）、终端代理（→ opencode /pty）、registry（扩展元数据）
  └── 登录: /sandbox 返回各服务地址（fs/pty/opencode/default_shell）→ 创建实例

服务端 (server/)
  ├── sandbox   :7780   调度（/sandbox 返回地址 + 生命周期：探活/自启 opencode 与 fs）
  ├── fs        :24097  文件系统服务（无 /fs 前缀；与 opencode 共享 cwd）
  ├── opencode  :24096  AI + 终端 PTY（/pty，node-pty）
  └── registry  :7781   vsix 扩展分发（HTTPS，kt-ext 协议；metadata.json + 静态资源）
```

扩展源码在 `server/extensions/<name>/`，打包成 vsix 交给 registry 分发；client 经
`/metadata.json` 拉取元数据，打开匹配文件（如 `.html` / `.paper`）时激活扩展（customEditor + webview）。

## 快速开始

```bash
npm install
npm run dev        # sandbox + registry + client 并发启动
```

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 工作台 | http://localhost:7788 | 浏览器打开 |
| sandbox | http://127.0.0.1:7780 | /sandbox 调度 |
| fs | http://127.0.0.1:24097 | 文件系统（sandbox 自动拉起） |
| opencode | http://127.0.0.1:24096 | AI + 终端（sandbox 自动拉起） |
| registry | https://127.0.0.1:7781 | 扩展分发（自签证书） |

### 首次运行：信任 registry 证书

registry 用自签 HTTPS（kt-ext 协议强制 https），首次需要把证书加入系统钥匙串：

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /Users/weizuxiao/Documents/开源项目/magicbook/server/registry/certs/cert.pem
```

（证书已含 SAN：`localhost` 与 `127.0.0.1`；重新生成：见 `server/registry/AGENTS.md`）

## 扩展开发与分发

1. **写扩展源码**：`server/extensions/<name>/`（package.json + 入口；**必须声明 `browser` 字段**（浏览器扩展，无 node 依赖））
   - HTML 预览示例：`server/extensions/html-preview/`（customEditor `*.html` → webview 渲染）
   - 试卷预览示例：`server/extensions/paper/`（复刻 yunyan-paper-web，customEditor `*.paper`）
2. **打包**：在扩展目录 `npx @vscode/vsce package --allow-missing-repository`
3. **分发**：把 `.vsix` 放入 `server/registry/vsix/`，然后：

```bash
cd server/registry
npm run build     # 扫描 vsix → 解压 dist/<id>/ + 生成 metadata.json
npm run serve     # HTTPS 分发（:7781）
```

4. **客户端加载**：刷新工作台 → 打开匹配文件（如 `demo.html` / `demo.paper`）→ customEditor 激活 → 预览。

> 扩展激活链路：metadata → 打开文件触发 `onCustomEditor:<viewType>` → 拉取 `browser` 入口 → 注册 provider → resolve webview。
> 常见问题（FileType 常量 / 证书 / 控制帧过滤 / __PAPER_MANIFEST__ 等）见 [`AGENTS.md`](./AGENTS.md) 的「常见问题与修复」速查表。

## 目录

| 路径 | 职责 |
| --- | --- |
| `client/` | opensumi/codeblitz 容器 + 适配层（RemoteFS / 终端 / registry）+ 登录 |
| `server/sandbox/` | 调度（/sandbox 返回地址；管理 opencode/fs 生命周期） |
| `server/fs/` | 文件系统服务（:24097，无 /fs 前缀） |
| `server/registry/` | vsix 扩展分发（HTTPS，kt-ext；build → metadata.json + 静态资源） |
| `server/extensions/` | vsix 扩展源码（html-preview / paper） |
| `workspace/` | 运行时工作区（gitignore） |

## License

MIT