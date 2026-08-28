# AGENTS.md — Numas (牛马们) AI 协作约定

> 给 AI/开发者的过程文档。README.md 是终态架构 (给人看); 本文件是过程/决策/踩坑 (让 AI 能跟踪迭代)。
> 品牌: **Numas (牛马们) — 打工人首选工作模式**。对标腾讯 workbuddy 类产品。

## AI 协作铁律 (放最前, 必读)

> **所有技术选型, AI 只能给方案推荐, 不得做决策. 多个候选方案时列推荐 + 备选, 等用户拍板再实施.**
>
> 这条规则覆盖: 库/命令/命名/目录结构选型、公开 API/数据模型/配置 schema 变更、跨模块或跨项目耦合改动、新依赖/新工具/新流程引入、删除/覆盖/迁移/远程写入/重写历史等不可逆动作.
>
> 解释权归用户. AI 自主做的仅限: 拼写/格式/注释修复、已约定命名替换、单元测试补全、只读操作 (跑命令/读日志/截图). 其他全部走 `question` 让用户拍板.

## 当前状态

| 端 | 目录 | 职责 |
| --- | --- | --- |
| 入口 | `dev.js` (根) | npx bin 入口: 装 web deps + spawn `npm run dev` (detached), 同步启 opencode |
| 客户端 | `web/` | codeblitz 容器 + 8 service + 4 extension; webpack 只 build, 不管 opencode |
| 后端 | opencode (外部) | AI + 终端 PTY + 文件系统; dev.js spawn `opencode serve` |
| 扩展 | `extensions/` | vsix 源码 |
| 分发 | `registry/` | vsix 扩展分发 (代码保留, dev 不启动) |

架构: client → opencode 直连, 无中间层. 进程树: dev.js → { opencode, webpack } (两个独立 detached 进程组, dev.js 退出时整组杀). 详图见 README.

## 品牌资产

- 名称: **Numas** (无括号中文, 跟 `index.html` title 一致)
- Logo: `web/src/assets/logo.svg` — **🐮 emoji 原样** (Apple 系统 emoji 字体, 透明背景); chat webview 内通过 `brand.ts.logoChar='🐮'` 渲染
- Favicon: `web/src/assets/favicon.ico` (16/32/48 PNG-in-ICO) + `favicon.png` (64x64) — 🐮 emoji 截图抠图 (sharp 去白底), 透明 RGBA
- 重生成: `.tmp/favicon-build/build-cow.js` (用 playwright 截 Apple Color Emoji, sharp 抠图+拼 ICO)
- 调试日志需要保留 (`web/src/extensions/chat/commands/api.ts` 的 `[meta] stat` 之类) 后续排除问题用

## 任务执行

按上级 `../AGENTS.md` (用户级) 的「核心决策规则」与「标准工作流程」执行. 本文件项目级约束优先.

## 关键决策 (Why)

**1. 砍中间层, client → opencode 直连**: 中间层 HTTP 反代导致写文件 409 死锁 (单 session 一次只能跑一个 shell) + 终端 ws 卡死 + CORS 散落. 解法: 写操作走单例 PTY, 读操作走全局 API.

**2. 端口单一事实源 (opencode 24096 / webpack 7788)**: webpack.config.js 内部启 opencode, 同 config 同时定端口, 走 env (`OPENCODE_PORT` / `WEB_PORT` / `OPENCODE_WEB_PORT`), .env 兜底.

**3. fs 写走单例 PTY (FsPty)**: 替代 `client.session.shell`. PTY 是全局的, 无 session 限制, promise chain 串行化. 0 个 409.

**4. 平铺 `core/` → `commands/` `config/` `styles/`**: 历史 core/commands/ + core/config/ + core/styles/ 三层嵌套冗余, 拍平到 src/ 根, 删 core/. 0 行逻辑改动.

**5. npx 一行启动 (根 `dev.js`)**: 公开 GitHub 仓库, `npx github:user/repo` 自动拉 tarball + install + 跑 bin. 零发布成本. bin 单文件 (dev.js), 不需要 cli/ 子目录编排. dev.js 持有 opencode + webpack 两组进程, SIGINT 杀整组.

**6. 依赖下沉**: root 只留 `opencode-ai` (opencode 二进制, 提供给 webpack 启), client 全套 react/codeblitz/webpack. root node_modules 0M (opencode-ai 装在 web/node_modules).

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
| **spdlog node-gyp 失败** | 其他同学 macOS Python 3.14 删 distutils → `npm install` 跑 `node-gyp rebuild` 必崩 | `npm install --ignore-scripts` 跳过 spdlog native build, opensumi 走 JS fallback logger | `dev.js#ensureInstalled` installArgs 加 `--ignore-scripts` |
| **npx 不提示确认** | npm exec 升级后, 未知包(github:) 默认要按 y | 文档提示用 `npx -y` | `README.md` 命令改 `npx -y` |
| **启动后没自动开浏览器** | dev.js 启动后只 print, 用户得手动复制 URL | sleep 4s 后 spawn `open` / `xdg-open` / `start` | `dev.js` 末尾 `setTimeout(4000)` opener 分流 |

## 踩坑速查

### 架构 / 端口 / 启动

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| npx 首次执行不提示确认 (y) | npm exec 升级后对未知包 (github:) 默认要确认, 且若 npm 缓存失败命中则跳过 | 文档统一 `npx -y github:weizuxiao911/numas`, -y 跳过确认; 缓存命中失败时手动 `rm -rf ~/.npm/_npx` 触发重新问 |
| spdlog node-gyp rebuild 失败 (Python 3.14 没 distutils) | `@opensumi/ide-logs@3.6.5` deps `spdlog@^0.9.0` 是 deprecated + native; Python 3.14 删 distutils 后 node-gyp@9 必崩 | dev.js#ensureInstalled 加 `--ignore-scripts` 跳过 postinstall; spdlog 没 build 但 opensumi 自动 fallback JS logger, 主流程不受影响 |
| 启动后没自动打开浏览器 | dev.js 启动完只 print URL | 末尾 sleep 4s + spawn `open` (mac) / `xdg-open` (linux) / `cmd /c start` (win) http://localhost:7788; 失败仅 warn 不阻塞 |
| cli's --port 改了, 客户端连不上 | .env 跟 cli 漂移 | cli 注入 process.env.APP_BASE_URL, webpack 优先读 process.env, .env 兜底 |
| 中文路径 fetch header 报 non-ISO-8859-1 | HTTP header 限制 | `encodeURI()` 包裹 x-opencode-directory; opencode 自动 decode |
| `__APP_OPENCODE__` 永远 undefined, chat 报 "opencode client not ready" | `agent.getClient()` 创 SDK 时 CJK cwd 没 encode, `createOpencodeClient` 抛错被 try/catch 吞 | `getClient()` line 126 也要 `encodeURI(cwd)` (跟 cwdHeader 同源; 不是 fetch 直连, 是 SDK 内部 mergeHeaders) |
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
| customEditor 不匹配 (.paper 用文本打开) | 无语言注册 | contributes.languages 注册扩展名; activationEvents 与 viewType 一一致 |
| chat agent dropdown 只有 build/plan, 漏掉 .opencode/agents/*.md 自定义 agent | aiListAgents 直接 `fetch /agent?directory=/` 不带 `x-opencode-directory` header, opencode 走 home 解析 | 改用全局 SDK `client.app.agents({query:{directory:cwd}})`; SDK 已带 cwdHeader |
| opencode HTTP 调用绕过 SDK, 散落 fetch | 早期 chat/commands/api 5 处直接 fetch, dir 用 `window.location.pathname=/`, 漏 cwd | **所有 opencode HTTP 必须走全局 SDK** (`window.__APP_OPENCODE__`, service/agent 创建, 单实例); fetch 仅 SDK 不可用时兜底, 仍要带 cwd header; helper: `getAiDirectory()` / `getAiCwdHeader()` |
| chat model 下拉显示"无匹配模型" | SDK v2 `client.config.providers` 返回 `{providers, default}` (新 API), 但代码取 `{all, connected}` (v1 旧 API), 拿不到 | 改用 `client.provider.list` (v1, 仍是 `{all, connected, default}`); 注意 SDK 端点选择: `app.agents` (数组), `provider.list` (v1 shape), `config.providers` (v2 shape), 别混用 |

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
- **tsx 统一**: bin/cli.cjs + cli/src/main.ts 走 tsx; web/webpack.config 走 JS (已切, 不再 .ts/.js 双源).
- **品牌**: Numas (牛马们) — 打工人首选工作模式. 文档/banner 体现这调性.
- **临时文件统一放 `.tmp/`** (项目根, 已在 .gitignore): 日志/截图/临时数据/调试产物全部进 `.tmp/`. **禁止**写到 `/tmp/` (散落难追踪) 或项目其他目录 (污染源码). 后台进程 `&> .tmp/<name>.log` 是标准写法.
- **AI agent 操作造成的 stray 零容忍** (本规则对上条的强制版本):
  - playwright mcp 截图/落盘 `filename` 一律**绝对路径** `.tmp/<name>.png` (默认 workdir 是项目根, 不传绝对路径会污染源码目录).
  - 任何 `> file` / `tee file` / 截图工具的输出, 落盘路径必须在 `.tmp/` 下.
  - 每次写完一组操作**必须自检** `git status --short` + `ls .tmp/` 确认没有散落到项目根或子目录的 stray 文件 (`.png` / `.log` / `.txt` / `.html` 等).
  - 发现 stray 立刻 `mv` 到 `.tmp/` (mv 不算"破坏性操作", AGENTS 用户级规则允许), 不得留在项目目录.

## 验证清单

```bash
cd client && npm run typecheck                # tsc --noEmit 通过
node cli/bin/cli.cjs                          # cli web 起来; opencode 24096 + webpack 7788
# **必须**用 playwright MCP 打开 http://localhost:7788 验证 (重启 dev 后尤其要)
# explorer 列表正常 + 上传文件 + 终端 三件套
```
