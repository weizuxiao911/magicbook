# AGENTS.md — AI 工作台 项目 AI 协作约定

> AI agent 速查表。**本文件是过程文档**: 记录项目怎么一步步走到现在, 为什么这么做, 改东西前要避免哪些坑。
> README.md 是**架构终态文档** (给人看), 本文件是**过程文档** (给 AI 看, 让它能跟踪迭代)。

## 当前状态速写 (项目终态)

`AI 工作台` 是本地模式浏览器端工作台。client → opencode 直连, 无中间 HTTP 代理, 单一事实源是 cli 入口。架构详图见 README.md。

| 端 | 目录 | 职责 |
| --- | --- | --- |
| 入口 | `cli/` | 进程编排器: npx bin + web/serve 路由 + opencode 进程组管理 |
| 客户端 | `client/` | codeblitz 容器 + 8 service + 4 内置 extension |
| 后端 | opencode (外部) | AI + 终端 PTY + 文件系统; cli 拉起的子进程 |
| 扩展 | `extensions/` | vsix 源码 |
| 分发 | `registry/` | vsix 扩展分发 (独立进程) |

## 任务执行

按上级 `../AGENTS.md`（用户级）的「核心决策规则」与「标准工作流程」执行; 本文件的项目级约束优先。

## 关键决策与权衡 (Why)

### 为什么 client → opencode 直连 (无中间层)

- **历史**: 早期有中间层 (:7789), 反代 `/ai/*` 到 opencode, 内置 `/fs/*` HTTP 路由, `/workspace/*` 调度
- **痛点**:
  - 写文件 409 死锁: 中间层用 opencode session 跑 shell, 单 session 一次只跑一个 shell, 并发就 409
  - 终端 ws 卡死: bun 跑 http-proxy 的 ws 握手问题
  - CORS 散落: 多个 base url 配置
  - 调度复杂: workspace 选择要先 ensure opencode 启动
- **解法**: 砍掉中间层
  - 写文件走 opencode 全局 PTY (单例, promise chain 串行)
  - 读文件走 opencode 全局 API (无 session 限制)
  - 终端走 `/pty/{id}/connect` (每终端独立 session)
  - session.shell 仅服务 chat agent 工具调用

### 为什么端口统一在 cli (单一事实源)

- **历史**: 早期 `APP_BASE_URL` 写在 `.env.development`, 改 cli 端口要改两边
- **痛点**: webpack 编译期注入 `__APP_BASE_URL__`, cli 端口改 webpack 不知道, 客户端连不上
- **解法**: cli 解析 `--port` → `process.env.APP_BASE_URL` → spawn 时 env 继承 → webpack 读 process.env 优先, .env 兜底
- **结果**: 改 `cli --port 4000` 全栈同步, 一处配置

### 为什么 fs 写走单例 PTY (不用 session.shell)

- **历史**: fs.ts 用 `client.session.shell({ sessionID, agent: 'build', command })` 跑 mkdir/rm/mv/base64 等
- **痛点**: opencode session 一次只能跑一个 shell, 多个并发 fs.write 第二个起 409
- **解法**: 走 opencode `/api/pty` (全局, 无 session 限制), 单例 + promise chain 串行 + UUID marker 命令完成检测
- **结果**: 0 个 409, 5 并发写全过

### 为什么平铺 `core/` → `commands/` `config/` `styles/`

- **历史**: 早期 `client/src/core/commands/`, `core/config/`, `core/styles/` 三层嵌套
- **痛点**: 每个接口一个 `commands/X/index.ts` 单文件目录, `core/` 包装层无意义
- **解法**: 拍平到 `client/src/commands/X.ts` 等单文件, `core/` 删
- **结果**: 16 文件 → 11 文件 (-31%), 0 行逻辑改动

### 为什么用 npx github: 分发 (不是 npm publish)

- **用户决策**: "git clone 源码, 现状态" + "我的疑问就跟webpack有关! port 是cli 支持 --port的吧webpack又用.env?" + "仓库是开源的 public"
- **路径**:
  - 公开 GitHub 仓库 → 用户 `npx github:user/repo` 即可 (无需 npm 账号)
  - 加 `cli/bin/cli.cjs` 作 npx 入口 (CommonJS, 必须 JS, 不能 TS)
  - `package.json:bin: { cli: "cli/bin/cli.cjs" }`
  - 用户 `npx github:...` 走 bin → spawn `tsx cli/src/main.ts`
- **结果**: 零发布成本, 仓库即分发

### 为什么 deps 全下沉 (root 18 个 webpack devDeps → client)

- **历史**: 早期 root `package.json` 有 18 个 webpack 工具链 devDeps, client 没自己的 deps
- **痛点**: 依赖管理混乱, root 装 webpack 但 webpack 是 client 用的
- **解法**:
  - root 只留 `tsx` (cli/bin 用), devDeps 从 18 减到 1
  - client 自己装 react + codeblitz + webpack + 所有 devDeps
  - cli 删 `opencode-ai` (cli spawn 拉二进制, 不 import SDK, -174M)
- **结果**: root node_modules 11M, cli 36M, client 766M

### 为什么 .env 从项目根 → client/

- **历史**: `.env.development` 在项目根, webpack 读 `../.env.development`
- **痛点**: cli 是项目级入口, .env 也该是项目级; 但 webpack 是 client 工具, 依赖外置 .env 不直观
- **解法**: 搬到 `client/.env.development`, webpack 读 `./.env`, project root 兜底 (兼容老路径)
- **结果**: .env 局部化, cli 不读 .env (用 process.env 注入)

## 变更日志 (How we got here)

> **AI 读法**: 看完这一节, 你会知道每个决策触发的问题、改动、为什么; 后续改东西前先扫一遍最近 3 条。

| 日期 | 触发问题 | 决策 | 实施 |
| --- | --- | --- | --- |
| 初始版本 | 仓库结构混乱 (servers/ 目录多层) | 整理仓库 | servers 移除, 扩展/webview 配置上移 |
| 中间层时代 | 早期架构有 HTTP 反代 | 统一 `APP_BASE_URL` 派生所有地址 | 中间层 tsx 运行 + opencode 逃逸加固 + 终端走 /ai/pty + 信息接口 |
| **重构 1 (33ffdfc)** | 客户端/中间层/opencode 三层, 写文件 409, 终端 ws 卡死, CORS 散落, 端口双源 | 砍中间层, client → opencode 直连 | 中间层目录 → cli/ 改名 + 子命令 web/serve; PTY 替 session.shell; 平台 shell-ops; encodeURI CJK 路径; 平铺 core/ |
| **重构 2 (依赖清理)** | root 装 500M webpack 工具链; cli 装 174M opencode-ai (实际不 import) | 依赖下沉 + 删未用 | root 留 tsx; client 装 webpack; cli 删 opencode-ai |
| **重构 3 (npx 分发)** | 用户问 "别人怎么用" | 公开 GitHub 仓库走 npx github: | `cli/bin/cli.cjs` npx 入口 (44 行 CommonJS) + `package.json:bin` |
| **重构 4 (端口单一源)** | `cli --port` 改了 webpack 不知道, 客户端连不上 | cli 设 process.env, webpack 优先读 env | `cli/bin/cli.cjs` 解析 `--port` → `process.env.APP_BASE_URL` → webpack DefinePlugin 注入 |
| **重构 5 (client-port)** | 用户问 "client 端口怎么改" | 加 `--client-port` flag | cli 解析 → `process.env.CLIENT_PORT` → webpack `devServer.port`; CORS auto-derived |
| **重构 6 (env 搬迁)** | .env 在项目根, webpack 读 `../.env` 跨目录 | 搬到 client/ | `client/.env.development`, webpack 读 `./.env`, project root 兜底 |
| **重构 7 (CJK 路径)** | 中文路径 fetch header 报 non-ISO-8859-1 | `encodeURI` 包裹 header | 6 处 `cwdHeader` 全部 `encodeURI` |
| **重构 8 (docs)** | README/AGENTS 还提旧中间层架构 | 删旧架构全部引用 | README 讲终态架构, AGENTS 讲过程决策 |

## 踩坑速查 (踩过的坑, 改东西前先查这里)

### 架构 / 端口 / 启动

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| cli's --port 改了, 客户端连不上 | 旧架构 .env 跟 cli 各自配置, 两边漂移 | 单一事实源: cli 注入 process.env.APP_BASE_URL, webpack 优先读 process.env, .env 兜底 |
| 中文路径 fetch header 报 non-ISO-8859-1 | HTTP header 限制 | `encodeURI()` 包裹 x-opencode-directory; opencode 收到 %E5%BC% 开头的 ASCII 自动 decode |
| 写文件 409 Conflict | opencode session 单 shell 限制, 并发 6 写 → 第 2 个起 409 | 写操作改走 FsPty 单例 PTY（全局, 无此限制）+ promise chain 串行化 |
| Explorer 列表 500 (无 APP_CWD) | WorkspacePicker 硬编码 `browseDir('~')`, opencode 不展开 ~ | picker 拉 opencode /path 拿 home + hostCwd, expandHome 展开 ~/ 路径 |
| 切 client 端口 (--client-port 8000) 报 unknown arg | cli --client-port 透给 opencode | cli/bin/cli.cjs splice 掉 --client-port, 只留 opencode 认识的 args |
| npm install root 装 500M (18 个 webpack) | 早期 root 装 client 全套 devDeps | root 只留 tsx, webpack 工具链下沉 client/ (-98%) |
| cli/node_modules 174M (opencode-ai) | cli 误把 opencode-ai 列 dep, 实际用 spawn 拉二进制不 import | 删 cli/package.json 的 dependencies, 只留 devDeps (174M → 36M) |
| npx 一行启动 | 没有 bin 入口 | 加 `cli/bin/cli.cjs` (CommonJS, 44 行) + root package.json `bin: { cli: "cli/bin/cli.cjs" }` |
| core/ 目录嵌套冗余 | core/commands/ + core/config/ + core/styles/ 三层 | 平铺: commands/ config/ styles/ 直接到 src/ 根, 删 core/ |

### 终端（client → /pty/{id}/connect）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 终端创建失败（cannot create ptyInstance） | 旧逻辑读 ptyUrl（pty_base_url 已废弃, 为空） | 终端 base = app_base_url（opencodeBaseUrl 派生, terminal.ts） |
| 终端 ws 一直 CONNECTING / loading | opencode /pty/{id}/connect 握手时序问题 | 等 ws open（3s 超时兜底）+ onMessage readyState 防御 |
| 创建后立即输入抛 WebSocket CONNECTING send | create2 返回时 ws 未 open | 等 ws open（3s 超时兜底）+ onMessage readyState 防御 |
| 默认 shell 变成 bash | applyRuntime 未注入 default_shell | agent.initRuntime 拉 /pty/shells 探测, 优先 zsh（macOS） |
| opencode 逃逸（kill -9 cli 后残留） | spawn 用 detached+unref, 清理只靠 exit 信号 | 整进程组 SIGKILL（kill(-pgid)）+ pkill 同步化 + 启动兜底 cleanupOrphans |

### 文件系统（client → /api/fs/* + FsPty）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `.opencode` 等目录显示为文件 | FileType 常量错（1/2） | 用 BrowserFS 枚举：FILE=32768 / DIRECTORY=16384 |
| 宿主机改文件编辑区不更新 | OverlayFS InMemory 缓存遮蔽 server 内容 | RemoteFS 读写全直连 server（无缓存）；外部事件 fireFilesChange 转 opensumi |
| 宿主机文件被循环写回 | fireFilesChange → onDidChangeFiles 钩子互触发 | 不挂 onDidChangeFiles/onDidCreateFiles（backend 直落）；只留 onDidSaveTextDocument 兜底 |
| 保存报 FileIsOutOfSync | Stats 未传 mtime（每次 Date.now()） | toStats 传 server mtime（Date.parse），保存时 lastModification 稳定 |
| readFile 报 Buffer.from undefined | globalThis.Buffer 不存在 | `import { Buffer } from 'buffer'`（codeblitz 依赖内, 非 node: 前缀） |
| explorer「无打开的文件夹」 | 挂载时 fsUrl 未就绪（登录前）或 workspaceDir 不匹配 | workspaceDir='/'；RemoteFS 根目录 stat 兜底返回空目录（登录后刷新填充） |
| stat 输出 `directory\|11808\|...` (走错路径) | 早期 stat 用 `meta` 返回 `regular file\|15\|...` 错配到目录 | 重构后 `meta` 走 FsPty 跑平台 stat, 输出 `<type>\|<size>\|<mtime>` 三段, 严格正则匹配 |

### registry / vsix 扩展（:7790，HTTPS，kt-ext）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| ext host 读 `pkgNlsJSON['zh-CN']` 崩溃 | 元数据缺 codeblitz 字段 | build 生成完整 IExtensionBasicMetadata：defaultPkgNlsJSON/pkgNlsJSON/nlsList/extendConfig/webAssets/mode='local'/uri |
| 扩展资源 404 | kt-ext uri 拼了 /extension/dist 前缀 | uri = `kt-ext://<host>/<id>`（解压内容根, animbook 布局） |
| ERR_CERT_AUTHORITY_INVALID | 自签证书未系统信任 | 自签带 SAN（DNS:localhost, IP:127.0.0.1）+ `sudo security add-trusted-cert`（系统钥匙串；Chrome 不认用户钥匙串） |
| vsicons 等内置资源被重写到 registry | StaticResource resolve 覆盖了原 host | resolve 保留 uri.authority（只 kt-ext→https），registry 扩展与内置市场各自命中 |
| 扩展完全不加载（main 不拉取） | 扩展 host 未启动（默认 noExtHost: true）或 ITaskService 缺失 | 不设 noExtHost（默认 web 扩展走 worker）；modules 加 TaskModule（@opensumi/ide-task） |
| customEditor 不匹配（.paper 用文本打开） | 无语言注册 | contributes.languages 注册扩展名（id + extensions）；activationEvents 必须与 viewType 完全一致（如 onCustomEditor:magicbook.paperEditor） |
| `__PAPER_MANIFEST__ is not defined` | esbuild 直接跑没注入 define | 用项目的 esbuild.config.mjs（define __PAPER_MANIFEST__ = webview vite manifest） |
| vsix 必须 browser 兼容 | codeblitz 纯浏览器, main 只在 node | package.json 声明 browser 字段（main 别名）；bundle 禁 node builtins（fs/path 等） |

## 关键文件位置

```
magicbook/
├── package.json            # 顶层 bin (cli) + dev/serve scripts; devDeps: tsx
├── cli/
│   ├── bin/cli.cjs         # npx 入口: 解析 --port/--client-port, 设 process.env, spawn tsx
│   ├── src/main.ts         # web/serve 路由; spawn opencode + spawn webpack (npm 间接)
│   └── package.json        # devDeps: tsx + typescript (无 opencode-ai; 用 spawn 拉二进制)
├── client/
│   ├── package.json        # 全部 react/codeblitz/webpack 等 deps
│   ├── webpack.config.ts   # 内嵌; 端口读 process.env.CLIENT_PORT; .env 兜底
│   ├── .env.development    # cli 不走时的兜底
│   ├── src/commands/       # 平铺的接口+Token (单一文件 per 接口)
│   ├── src/config/         # 初始化/模块/布局
│   ├── src/service/        # 8 实现
│   ├── src/extensions/     # chat / workspace / login / actions / welcome
│   └── src/styles/         # CSS
├── extensions/             # 扩展源码: html-preview / paper
└── registry/               # 扩展分发: build → metadata.json + 静态资源（:7790）
```

## 关键命令

```bash
# 用户使用 (推荐)
npx github:weizuxiao911/magicbook              # 一行启动 (cli's web 模式)

# 开发者本地
npm install                                  # 根: 装 tsx (~10s)
cd cli && npm install                         # 装 cli 的 tsx/typescript (~5s)
cd ../client && npm install                   # 装 react/codeblitz/webpack (~30s)
cd ../.. && npm run dev                       # 或: node cli/bin/cli.cjs

# 单独模式
npx github:weizuxiao911/magicbook serve       # 只起 opencode (无 client)

# 验证
cd client && npm run typecheck                # tsc --noEmit
```

## 约定 / 禁忌

- **单一事实源**：端口、CORS、APP_BASE_URL 全由 cli 控制, 透 process.env 注入 webpack；不要散落到各 service / 各模块。
- **跨层只通过协议交互**：client 调 opencode API；不直连 opencode 进程内部状态。
- **直连无代理**：client → opencode 之间不加任何 HTTP 中间层（历史教训: 中间层带来 409 死锁 / ws 卡死 / CORS 散落）。
- **写操作走 PTY，不走 session.shell**：session 单 shell 限制 → 409 风暴；PTY 是全局的，无此问题。
- **中文路径 encodeURI**：HTTP header 必须 ISO-8859-1, `x-opencode-directory` 需 `encodeURI()`。
- **平台兼容**：fs 命令按 host 平台分流（mac/linux=POSIX, win=PowerShell）；shell 选择走 `/pty/shells` 探测，不猜 UA。
- **单一职责**：每个模块只做一件事，不跨模块堆逻辑。
- **配置外置**：敏感信息不入库（.env 走 .gitignore）。
- **中文优先**：文档、接口说明、用户可见文案以中文为主。
- **tsx 统一**：bin/cli.cjs + cli/src/main.ts + client/webpack.config.ts 全走 tsx（替代历史 ts-node 链路）。

## 验证清单（改完跑）

```bash
cd client && npm run typecheck                # tsc --noEmit 通过
node cli/bin/cli.cjs                          # cli web 模式起来; opencode 3100 + webpack 7788
# 浏览器开 http://localhost:7788
# explorer 列表正常 + 上传文件 + 终端 三件套
```

## 待优化交互体验问题（登记）

| 问题 | 现象 | 期望 | 备注 |
| --- | --- | --- | --- |
| 编辑器拆分布局刷新后空分组无法关闭 | 拆分 2 个区域后刷新，新增分组（右 group）无 tab 且无法关闭；空分组不自动让出宽度 | 分组为空时自动关闭/让出宽度，其他分组铺满 main 区域 | 根因在 opensumi 恢复的 group 状态（backend 建 tab 未加载、close 被卡）；曾尝试 client 恢复拆分结构（fs.ts），方向复杂已放弃；后续可从「检测空/异常 group 自动 dispose」或「恢复后清理无渲染 group」入手 |
