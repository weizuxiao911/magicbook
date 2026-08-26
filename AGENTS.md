# AGENTS.md — Numas (牛马们) AI 协作约定

> 给 AI/开发者的过程文档。README.md 是终态架构 (给人看); 本文件是过程/决策/踩坑 (让 AI 能跟踪迭代)。
> 品牌: **Numas (牛马们) — 打工人首选工作模式**。对标腾讯 workbuddy 类产品。

## 当前状态

| 端 | 目录 | 职责 |
| --- | --- | --- |
| 入口 | `cli/` | 进程编排器: npx bin + web/serve 路由 + opencode 进程组管理 |
| 客户端 | `web/` | codeblitz 容器 + 8 service + 4 extension |
| 后端 | opencode (外部) | AI + 终端 PTY + 文件系统 |
| 扩展 | `extensions/` | vsix 源码 |
| 分发 | `registry/` | vsix 扩展分发 (独立) |

架构: client → opencode 直连, 无中间层. 单一事实源是 cli 入口. 详图见 README.

## 任务执行

按上级 `../AGENTS.md` (用户级) 的「核心决策规则」与「标准工作流程」执行. 本文件项目级约束优先.

## 关键决策 (Why)

**1. 砍中间层, client → opencode 直连**: 中间层 HTTP 反代导致写文件 409 死锁 (单 session 一次只能跑一个 shell) + 终端 ws 卡死 + CORS 散落. 解法: 写操作走单例 PTY, 读操作走全局 API.

**2. 端口单一事实源 (cli)**: 改 cli `--port` 一次到位, 透 process.env 注入 webpack, 避免 .env 跟 cli 漂移.

**3. fs 写走单例 PTY (FsPty)**: 替代 `client.session.shell`. PTY 是全局的, 无 session 限制, promise chain 串行化. 0 个 409.

**4. 平铺 `core/` → `commands/` `config/` `styles/`**: 历史 core/commands/ + core/config/ + core/styles/ 三层嵌套冗余, 拍平到 src/ 根, 删 core/. 0 行逻辑改动.

**5. npx 一行启动 (cli/bin/cli.cjs)**: 公开 GitHub 仓库, npx github:user/repo 自动 clone + install + 跑 bin. 零发布成本.

**6. 依赖下沉**: root 只留 `tsx`, client 全套 react/codeblitz/webpack, cli 只 `tsx` + `typescript` (删了 opencode-ai 174M). 各管各, root node_modules 11M.

**.env**: 搬到 `web/.env.development` (client 局部). webpack 优先 process.env, 兜底读 .env.

## 变更日志

| 日期 | 触发 | 决策 | 实施 |
| --- | --- | --- | --- |
| 初始 | 仓库结构混乱 (servers 目录多层) | 整理 | servers 移除, 扩展/webview 配置上移 |
| 中间层时代 | 早期架构有 HTTP 反代 | 统一 `APP_BASE_URL` 派生 | 中间层 tsx 运行 + 信息接口 + opencode 逃逸加固 + 终端走 /ai/pty |
| **重构 (33ffdfc)** | 客户端/中间层/opencode 三层, 写文件 409, 终端 ws 卡死, CORS 散落, 端口双源 | 砍中间层, client → opencode 直连 | 中间层目录 → cli/ 改名 + web/serve; PTY 替 session.shell; 平台 shell-ops; encodeURI CJK 路径; 平铺 core/ |
| 依赖清理 | root 装 500M webpack 工具链; cli 装 174M opencode-ai (不 import) | 下沉 + 删未用 | root 留 tsx; client 装 webpack; cli 删 opencode-ai |
| npx 分发 | "别人怎么用" | 公开 GitHub 仓库走 npx github: | `cli/bin/cli.cjs` npx 入口 + `package.json:bin` |
| 端口单一源 | `cli --port` 改了 webpack 不知道, 客户端连不上 | cli 设 process.env, webpack 优先读 env | `cli/bin/cli.cjs` 解析 `--port` → `process.env.APP_BASE_URL` → webpack DefinePlugin 注入 |
| 加 client-port | "client 端口怎么改" | `--web-port` flag | cli 解析 → `process.env.WEB_PORT` → webpack `devServer.port`; CORS auto-derived |
| env 搬迁 | .env 在项目根, webpack 读 `../.env` 跨目录 | 搬到 web/ | `web/.env.development`, webpack 读 `./.env`, project root 兜底 |
| CJK 路径 | 中文路径 fetch header 报 non-ISO-8859-1 | `encodeURI` 包裹 header | 6 处 `cwdHeader` 全部 `encodeURI` |
| 文档重写 | README/AGENTS 还提旧中间层架构 | 删旧架构全部引用 | README 讲终态架构 + 图表, AGENTS 讲过程决策 |
| **品牌: Numas** | "对标腾讯 workbuddy, 打工人首选工作模式" | 改名 Numas (牛马们) | package name → `numas`, bin → `numas`, description + slogan 更新 |

## 踩坑速查

### 架构 / 端口 / 启动

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| cli's --port 改了, 客户端连不上 | .env 跟 cli 漂移 | cli 注入 process.env.APP_BASE_URL, webpack 优先读 process.env, .env 兜底 |
| 中文路径 fetch header 报 non-ISO-8859-1 | HTTP header 限制 | `encodeURI()` 包裹 x-opencode-directory; opencode 自动 decode |
| 写文件 409 Conflict | opencode session 单 shell 限制 | FsPty 单例 PTY (全局) + promise chain 串行化 |
| Explorer 500 (无 APP_CWD) | WorkspacePicker 默认 browse `~`, opencode 不展开 ~ | picker 拉 /path 拿 home + hostCwd, expandHome 展开 |
| 切 client 端口 (--web-port 8000) 报 unknown arg | cli --web-port 透给 opencode | cli/bin/cli.cjs splice 掉 --web-port |
| root node_modules 500M | 早期 root 装 client 全套 devDeps | root 只留 tsx, webpack 下沉 web/ (-98%) |
| cli/node_modules 174M | cli 误列 opencode-ai, 实际 spawn 拉二进制 | 删 cli/package.json dependencies, 只留 devDeps |
| npx 一行启动 | 没有 bin 入口 | `cli/bin/cli.cjs` (CommonJS, 44 行) + `package.json:bin:numas` |
| core/ 嵌套冗余 | core/commands/ + core/config/ + core/styles/ | 平铺到 src/ 根, 删 core/ |

### 终端 (client → /pty/{id}/connect)

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 终端创建失败 | 旧逻辑读 ptyUrl (pty_base_url 废弃) | 终端 base = opencodeBaseUrl (terminal.ts) |
| 终端 ws 一直 CONNECTING | /pty/{id}/connect 握手时序 | 等 ws open (3s 超时) + onMessage readyState 防御 |
| 创建后立即输入抛 CONNECTING send | create2 返回时 ws 未 open | 等 ws open |
| 默认 shell 变成 bash | applyRuntime 未注入 default_shell | agent.initRuntime 拉 /pty/shells 探测, 优先 zsh (macOS) |
| opencode 逃逸 (kill -9 cli 后残留) | spawn 用 detached+unref | 整进程组 SIGKILL (kill(-pgid)) + pkill 同步化 + 启动兜底 cleanupOrphans |

### 文件系统 (client → /api/fs/* + FsPty)

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `.opencode` 等显示为文件 | FileType 常量错 (1/2) | BrowserFS 枚举: FILE=32768 / DIRECTORY=16384 |
| 宿主机改文件编辑区不更新 | OverlayFS InMemory 缓存遮蔽 | RemoteFS 读写全直连 (无缓存) |
| 文件被循环写回 | fireFilesChange 钩子互触发 | 不挂 onDidChangeFiles (backend 直落) |
| 保存报 FileIsOutOfSync | Stats 未传 mtime | toStats 传 server mtime |
| readFile 报 Buffer.from undefined | globalThis.Buffer 不存在 | `import { Buffer } from 'buffer'` |
| explorer「无打开的文件夹」 | 挂载时 fsUrl 未就绪 | workspaceDir='/' + RemoteFS 根目录 stat 兜底 |
| stat 输出 `directory\|11808\|...` | 早期 stat 走错路径返回 | 重构后 meta 走 FsPty 跑平台 stat |

### registry / vsix (:7790, HTTPS, kt-ext)

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| ext host 读 `pkgNlsJSON['zh-CN']` 崩溃 | 元数据缺 codeblitz 字段 | build 生成完整 IExtensionBasicMetadata |
| 扩展资源 404 | kt-ext uri 拼了 /extension/dist 前缀 | uri = `kt-ext://<host>/<id>` (解压内容根) |
| ERR_CERT_AUTHORITY_INVALID | 自签证书未系统信任 | 自签带 SAN + `sudo security add-trusted-cert` |
| customEditor 不匹配 (.paper 用文本打开) | 无语言注册 | contributes.languages 注册扩展名; activationEvents 与 viewType 一致 |

## 关键命令

```bash
# 用户 (推荐)
npx github:weizuxiao911/numas              # web 模式 (opencode + client)

# 开发者
git clone https://github.com/weizuxiao911/numas
cd numas && npm install
cd cli && npm install && cd ..
cd client && npm install && cd ..
npm run dev

# 验证
cd client && npm run typecheck    # tsc --noEmit
```

## 约定 / 禁忌

- **单一事实源**: 端口/CORS/APP_BASE_URL 全由 cli 控制, 透 process.env 注入 webpack. 不要散落.
- **直连无代理**: client → opencode 之间不加 HTTP 中间层.
- **写操作走 PTY, 不走 session.shell**: session 单 shell 限制 → 409 风暴; PTY 是全局.
- **中文路径 encodeURI**: HTTP header 必须 ISO-8859-1, `x-opencode-directory` 需 `encodeURI()`.
- **平台兼容**: fs 命令按 host 平台分流 (mac/linux=POSIX, win=PowerShell); shell 走 `/pty/shells` 探测.
- **单一职责**: 每个模块只做一件事.
- **配置外置**: 敏感信息不入库.
- **中文优先**: 文档/接口/文案中文为主.
- **tsx 统一**: bin/cli.cjs + cli/src/main.ts + web/webpack.config.ts 全走 tsx.
- **品牌**: Numas (牛马们) — 打工人首选工作模式. 文档/banner 体现这调性.

## 验证清单

```bash
cd client && npm run typecheck                # tsc --noEmit 通过
node cli/bin/cli.cjs                          # cli web 起来; opencode 24096 + webpack 7788
# 浏览器开 http://localhost:7788
# explorer 列表正常 + 上传文件 + 终端 三件套
```
