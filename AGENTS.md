# AGENTS.md — AI 工作台 项目 AI 协作约定

> AI agent 速查表。修改前先看「项目速写」「分层思想」「约定 / 禁忌」再动手。

## 项目速写

`AI 工作台` 是**本地模式**的浏览器端可交互工作台。client → opencode 直连, 无中间 HTTP 代理, 单一事实源是 cli 入口。

| 端 | 目录 | 职责 |
| --- | --- | --- |
| 入口 | `cli/` | 进程编排器: npx bin (`bin/cli.cjs`) + web/serve 路由 (`src/main.ts`); opencode 进程组管理 |
| 客户端 | `client/` | opensumi/codeblitz 交互层（explorer / 编辑器 / 终端 / 聊天 / 扩展）|
| 客户端 | `client/src/commands/` | 接口+Token 定义 (IAgent/IRegistry/IFileSystem/IEnvService/IAuth) |
| 客户端 | `client/src/config/` | 初始化 / 模块注册 / 布局 / runtime config |
| 客户端 | `client/src/service/` | 8 实现 (agent/auth/env/fs/fs-pty/registry/shell-ops/terminal) |
| 客户端 | `client/src/styles/` | CSS 覆盖 |
| 服务 | opencode (外部) | AI + 终端 PTY + 文件系统; cli 拉起的子进程 |
| 扩展 | `extensions/` | vsix 扩展源码（html-preview / paper）|
| 分发 | `registry/` | vsix 扩展分发（HTTPS, kt-ext）|

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
│   ├── src/commands/       # 平铺的接口+Token (单一文件 per 接口)
│   ├── src/config/         # 初始化/模块/布局
│   ├── src/service/        # 8 实现
│   ├── src/extensions/     # chat / workspace / login / actions / welcome
│   ├── src/styles/         # CSS
│   └── .env.development    # cli 不走时的兜底
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

## 分层思想

> 本地模式, client → opencode 直连, **零中间层**。单一事实源是 cli 入口。
> 端口 (`--port`/`--client-port`) 一处配置, 通过 process.env 注入下游, 避免散落。

- **cli** = 进程编排器, 不是 HTTP 服务。它 spawn opencode + spawn webpack, 自己监听 SIGINT 整组清理。
- **opencode = `${APP_BASE_URL}`**（无 /ai 前缀; 单一事实源）。
- **cli's --port** → `process.env.APP_BASE_URL` → webpack DefinePlugin → `__APP_BASE_URL__` → 客户端 SDK 直连。
- **fs 写操作**走 FsPty 单例 PTY（`/api/pty` 全局，不依赖 session）+ 平台 shell-ops（POSIX/PowerShell）。
- **fs 读操作**走 opencode 全局 API（`/api/fs/list` `/api/fs/read/*` `/find/file`）。
- **terminal** 走 `/pty/{id}/connect` WebSocket（每终端独立会话）。
- **session.shell** 仅服务 chat agent 工具调用（不用于 fs 写, 避免 409）。
- **registry** 是唯一例外：编译期独立配置 `REGISTRY_BASE_URL`。

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

## 任务执行

按上级 `../AGENTS.md`（用户级）的「核心决策规则」与「标准工作流程」执行；本文件的项目级约束优先。

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 建立项目骨架（原 magicbook 仓库结构整理: servers 目录移除, 扩展/webview 配置上移） | 整个仓库 |
| 中间层时代 | 统一 APP_BASE_URL 派生架构; 中间层 tsx 运行 + opencode 逃逸加固; 终端走 /ai/pty; question 多问题 tab | 中间层/client |
| **本次重构 (33ffdfc)** | 砍掉中间层抽象, client → opencode 直连, cli 入口; PTY 替 session.shell; 平铺 core/ → commands/ config/ styles/; npx 一行启动 | 整个仓库 |

## 常见问题与修复（踩坑速查）

> 本会话积累的修复记录，改相关模块前先查这里。

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

### 架构要点

- **本地模式**：client → opencode 直连, 无 HTTP 中间层。cli 是进程编排器, 不是 HTTP 服务。
- **唯一配置**：cli 的 `--port` (默认 3100) 和 `--client-port` (默认 7788); 端口透 process.env 注入 webpack 编译期。
- **服务端口**：opencode :3100 (默认, cli 拉起) / client :7788 (默认, webpack-dev-server) / registry :7790 (独立)。
- **opencode 生命周期**：cli 独家调度 (spawn + detached); 整进程组 SIGKILL 防逃逸; 启动前 cleanupOrphans 清残留。
- **cwd 策略**：APP_CWD || hostCwd (opencode /path 注入到 __APP_CONFIG__.cwd); 都没则报错 (不默认 '/')。
- **fs 写操作**：单例 FsPty (lazy init, promise chain 串行, UUID marker 命令完成检测), 0 409 冲突。
- **fs 平台兼容**：mac/linux=POSIX (bash/zsh), win=PowerShell, cmd 兜底; shell 走 /pty/shells 探测, 不猜 UA。
- **CJK 路径**：`x-opencode-directory` header 用 `encodeURI()` 防 ISO-8859-1 报错。
- **扩展源码**：`extensions/<name>/`（入库）；产物（vsix/dist/uploads）归 registry（gitignore）。
- **vsix 开发规范（用户约定）**: **一律 TypeScript**（`src/extension.ts` + esbuild → `dist/extension.js`）;
  **webview 单独维护**（`webview/` 目录或 `webview.tsx`, 不内联拼 HTML 字符串）;
  **publisher 统一 `weizuxiao911`**（用户生产的 vsix 统一使用账号名）;
  **vsix 文件名规范 `{发布者}.{拓展名称}-{版本}.vsix`**（如 `weizuxiao911.magicbook-html-preview-0.1.0.vsix`, 由 vsce 打包默认生成）;
  项目统一 MIT 开源协议（根 LICENSE）
- **扩展加载机制**：metadata 注入 → customEditor 打开触发 onCustomEditor 激活 → 拉 browser 入口 → provider 注册 → resolve
- **npx 分发**：`npx github:weizuxiao911/magicbook` 走根 package.json 的 `bin: { cli: "cli/bin/cli.cjs" }` 入口 → cli/bin/cli.cjs (CommonJS, 44 行) → spawn tsx → cli/src/main.ts。

### 待优化交互体验问题（登记）

| 问题 | 现象 | 期望 | 备注 |
| --- | --- | --- | --- |
| 编辑器拆分布局刷新后空分组无法关闭 | 拆分 2 个区域后刷新，新增分组（右 group）无 tab 且无法关闭；空分组不自动让出宽度 | 分组为空时自动关闭/让出宽度，其他分组铺满 main 区域 | 根因在 opensumi 恢复的 group 状态（backend 建 tab 未加载、close 被卡）；曾尝试 client 恢复拆分结构（fs.ts），方向复杂已放弃；后续可从「检测空/异常 group 自动 dispose」或「恢复后清理无渲染 group」入手 |
