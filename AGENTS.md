# AGENTS.md — Numas AI 协作约定

> 给 AI 的项目事实 + 协作铁律. README.md 是给用户看的终态架构, 本文件是给 AI 看的工作上下文.
> 品牌: **Numas (🐮 牛马 AI)** — 打工人首选工作模式, 对标腾讯 workbuddy 类产品.

---

## AI 协作铁律 (最高优先级)

### 1. 技术选型铁律

> **所有技术选型, AI 只能给方案推荐, 不得做决策. 多个候选方案时列推荐 + 备选, 等用户拍板再实施.**

适用范围: 库/命令/命名/目录结构选型、公开 API/数据模型/配置 schema 变更、跨模块或跨项目耦合改动、新依赖/新工具/新流程引入、删除/覆盖/迁移/远程写入/重写历史等不可逆动作.

AI 自主做的仅限: 拼写/格式/注释修复、已约定命名替换、单元测试补全、只读操作 (跑命令/读日志/截图).

### 2. 交互协议铁律

> **所有需要拍板/选择/决策/不可逆操作的交互, 必须通过 `question` 工具列选项让用户拍板. 不得用普通文本/隐式同意/默认执行替代.**

AI 给方案推荐 + 备选时, **必须** 用 `question` 工具让用户点选, 不得用文本"我准备 X / 你 OK 吗? / 如果你同意" 等隐式询问.

### 3. 功能设计与架构决策铁律

> **一切功能设计和架构决策必须由用户拍板, AI 不得自行加戏.**

适用范围: 任何**未在对话中明确确认**的功能/特性/视觉/交互/状态/边界处理. 包括但不限于:

- 交互行为 (悬停提示 / 选中是否可取消 / 哪些操作触发哪些反馈)
- 视觉细节 (提示文字 / 颜色 / 动画 / 默认值)
- 状态机分支 (错误/成功/空状态展示, 边界处理)
- 字段/数据模型新增 (sidecar schema / popover 控件)
- 任何看起来"理所当然"或"用户应该会喜欢"的自作主张

### 4. 改动反馈铁律

> **只要 AI 动过项目文件 (任何改动, 不管多大), 完成后必须用 `question` 工具主动反馈, 询问 git 操作意向. 不得静默结束.**

反馈内容: 改了哪些文件 (简短列表) + 关键改动点 (1-2 句话).

选项必须包含: 提交+推送 (双远程) / 仅提交 / 暂存 / 不 git 操作 (用户拍板).

即使上一轮用户取消了 git 操作选择, 只要 AI 后续又执行了其他改动, 也必须**再次主动反馈**.

### 5. 代码改动 → 提交/推送 流程铁律

> **任何代码改动后, AI 必须用 `question` 工具反馈改动内容 + 列出提交/推送选项, 由用户决策. AI 不自作主张 `git add` / `git commit` / `git push`.**

典型选项: 提交 (1 commit) / 拆 N 个 commit / 不提交; 推 gitlab / 推 github / 两个都推 / 不推; 提交信息 AI 写 / 用户给.

**多远程仓库同步**: 本仓库配置了 2 个远程:
- gitlab: `gitlab.grjky.com/new-app/numas`
- github: `weizuxiao911/numas`

用户拍板"推送"时, **默认两个远程仓库都要推** (gitlab + github), 除非用户明确只推某一个.

推送后自检 `git push` 两个 remote 都执行, 缺一个要补.

### 6. 分层架构铁律

> **所有拓展文件系统操作必须通过 codeblitz 的文件系统和 opencode 访问服务器端, 不得直连 service.**

分层 (单向, 外层调内层, 内层不调外层):

```
外部  →  service  →  commands  →  codeblitz  →  extensions
```

- `extensions/` (`sumi/src/extensions/*`) 读写文件: 必须走 codeblitz (`@opensumi/ide-file-service` 的 `IFileServiceClient`) → opencode server fs API (`/api/fs/*`)
- **严禁** extensions 直接调用 service 层的 `__APP_FS__` / `service/fs.ts` 的任何方法
- service 层是 commands / codeblitz / 其他 service 调用的基础设施, 不暴露给 extensions 直调
- commands 层定义对外 API / token / interface, 是 service 与 codeblitz 之间的契约

### 7. 跨平台路径铁律

> **路径以 opencode 服务端真实路径为单一事实源. 禁止自行拼接/重写/添加前导 `/`. 任何路径处理走 `sumi/src/infra/path.ts` 工具函数, 不要直接写正则/字符串拼接.**

**事实**: codeblitz 暴露的 `idePath` 与 opencode 宿主机 `hostPath` **完全一致**, 仅多 `file://` 协议头 (codeblitz editor 用). 不存在中间虚拟化映射. AI 不得发明 `path.win32` / `path.posix` 转换 / 自定义"虚拟根"层.

**禁令**:
- **禁止硬编码前导 `/`**: `'/' + segments.join('/')` 会让 Windows drive 渲染成 `/D:/projects` 多余前缀 (历史 bug: `extensions/filepicker/FilePicker.tsx:232`). 正确做法: 按首段是否含 `:` 判断, Windows drive 直接作为根 (`D:` / `D:/projects`), POSIX 才补前导 `/`
- **禁止硬编码分隔符**: 跨平台统一用 `/`, 用 `normalizeSep()` (`\\` → `/`). 服务端协议 / UI 展示均 POSIX 分隔
- **禁止写死的 `isWindowsDrive` / `path.win32` 判断到处散落**: 集中用 `infra/path.ts`:
  - `normalizeCwdPath(p)`: Windows drive 去前导 `/` + 去尾 `/` (server `path.win32` 处理)
  - `normalizeSep(p)`: `\\` → `/`
  - `isWindowsDrive(p)`: 单一权威检测
  - `absToRel(abs, ws)`: 宿主机绝对路径 → workspace 相对路径
  - `toHostPath(idePath, anchors)`: codeblitz 虚拟路径 → opencode 宿主路径 (来自 `infra/path.ts:toHostPath`, 不自造)
- **禁止 `/D:/...` 形态直接传给 server**: 走 `normalizeCwdPath` 规范化. 否则 server `path.win32` 按 POSIX 根解析 → 500/错目录
- **HTTP header 路径必须 `encodeURI()`**: CJK + Windows drive 全角字符都需 URI encode (`x-opencode-directory` 等)

**正确示例**:
```ts
// 绝对路径拼接 (POSIX '/Users/foo' / Windows 'D:/projects' 都对)
const p = (segments[0]?.includes(':') ? '' : '/') + segments.slice(0, i + 1).join('/');

// 路径规范化
const safe = normalizeCwdPath(userInput);   // 'D:/projects' 而非 '/D:/projects'

// server 请求前
headers: { 'x-opencode-directory': encodeURI(workspace) }
```

**检测方法**: 改完路径相关代码, **必须** 在 `dataDir` 是 Windows 路径 (如 `D:/projects`) 时跑一次, 验证:
- 面包屑/foot-path 不出现多余 `/` 前缀
- `getWorkspace()` / `urlWorkspace()` 返回 `D:/projects` 而非 `/D:/projects`
- `fs.listDir('D:/projects')` 200, 不 500
- 中文路径 `测试/中文目录/文件.md` 正常 resolve

---

## 项目事实 (终态)

### 顶层结构

| 目录 / 文件 | 作用 |
| --- | --- |
| `dev.js` | 根 `package.json#bin`, npx 入口, 编排 build + spawn `opencode web --port 24096` |
| `package.json` | name=`numas`, deps 只有 `opencode-ai@^1.18.11` (binary 兜底), scripts `dev=node dev.js` |
| `sumi/` | **客户端 IDE** (codeblitz/opensumi + React), webpack 独立 build |
| `opencode/` | **完整 fork 的 opencode 仓库** (bun workspace, 31 个 packages), 内嵌编译产物被 dev.js spawn |
| `extensions/` | 三个独立 vsix 源码 (`html`, `paper`, `pdf`), esbuild 自打包 → registry @ 7790 分发, dev 模式**不加载** |
| `registry/` | vsix 注册表服务, 端口 7790, 手动启, dev 模式不自动启 |
| `docs/` | 4 篇 Markdown (架构 / 功能清单 / fs 设计 / 标注设计) |

### 客户端 (`sumi/src`)

**入口**: `sumi/src/index.tsx` (22 行) → 调 `installCustomEditorPatch()` (main-thread 接管 webview) + 挂 `window.__APP_CONFIG__` + ReactDOM.render.

**目录**:

| 目录 | 内容 |
| --- | --- |
| `commands/` | 4 接口 + Token: IFileSystem / IAgent / IEnvService / IRegistry |
| `config/` | app / brand / layout / modules / preferences / runtime / slots |
| `service/` | agent / env / fs / registry / terminal, 挂 `window.__APP_FS__` / `__APP_OPENCODE__` |
| `extensions/` | 8 内置: actions / ask / chat / filepicker / opentype / pdf / welcome / workspace |
| `patches/` | `patch-custom-editor.ts` |
| `styles/` | overrides.css (865 行) + slots.css (201 行) |
| `assets/` | favicon.ico/png, logo.svg (🐮) |

**BrowserModule 注册**: `sumi/src/config/modules.ts:7-39` 注册 14 个 (TerminalNextModule + TaskModule + AgentModule + RegistryModule + FileSystemModule + TerminalModule + EnvModule + ActionsModule + WelcomeModule + ChatModule + WorkspaceModule + FilePickerModule + PdfReaderModule + OpenTypeModule).

**通信方式**:

| 用途 | 协议 | 入口 |
| --- | --- | --- |
| 文件读 | HTTP `GET /api/fs/read/<path>` | `sumi/src/service/fs.ts:840` |
| 文件写 | HTTP `POST /api/fs/write` (base64) | `sumi/src/service/fs.ts:897` |
| 文件删 / 建 / 移 | HTTP `/api/fs/remove` / `/mkdir` / `/rename` | `service/fs.ts` |
| 终端 PTY | WS `${baseUrl}/pty/{id}/connect?directory=...` | `service/terminal.ts:325` |
| AI | SDK `@opencode-ai/sdk/v2/client`, header 自动带 `x-opencode-directory` | `service/agent.ts:184` |
| 事件 | `EventSource ${baseUrl}/global/event` (V1 SSE) | `service/fs.ts:711` |

**postinstall 改 node_modules** (`sumi/scripts/`):
- `patch-codeblitz-constant.js`: `constant.js` WORKSPACE_ROOT 取 APP_CWD → sessionStorage → `__APP_CONFIG__.cwd` → `/workspace`; `disk-file-system.provider.js` `fse.move` → 桥接 `window.__APP_FS__.move`
- `patch-opensumi-customeditors.js`: `customEditors.js` 改 useRef 版本, webview 生命周期交给 `sumi/src/patches/patch-custom-editor.ts` 的 main-thread 接管

### opencode fork (内嵌, 不是 npm 包)

`opencode/packages/opencode/` version `1.18.25`, 31 个 packages, bun workspace, `bin: { opencode, numas }`.

**fork 增量** (`packages/opencode/src/`):

| 路径 | 增量 |
| --- | --- |
| `index.ts:47` | `scriptName("numas")` 品牌 |
| `cli/network.ts:33-37` | `--registry <url>` flag |
| `cli/cmd/web.ts` | `web` 子命令 (instance: false, per-request workspace 路由, pre-warm + 1500ms 自动开浏览器) |
| `cli/cmd/serve.ts` | 无头模式, listen 不开浏览器 |
| `server/shared/ui.ts:17-21` | CSP 全开放 (给内嵌 opensumi 用) |
| `server/shared/ui.ts:71-77` | HTML 注入 `window.__APP_CONFIG__.registryBaseUrl` |
| `server/routes/instance/httpapi/middleware/workspace-routing.ts:87` | `x-opencode-directory` header + `?directory=` query per-request 路由 |
| `server/routes/instance/httpapi/groups/fs.ts` | `/api/fs/read` `/list` `/find` `/stat` `/write` `/mkdir` `/remove` `/rename` `/watch` 9 端点 |
| `server/routes/instance/httpapi/handlers/file.ts:96-125` | `/api/content` vscode 兼容端点 (vsix ext 用) |
| `control-plane/` | workspace.ts (966 行) + types / adapters (worktree) / workspace-context / workspace-adapter-runtime / dev-debug-workspace-plugin / util |
| `effect/` | Effect-TS 服务运行时 + run-service / instance-state / instance-registry / bootstrap-runtime / app-runtime / bridge |
| `event-v2-bridge.ts` | V2 事件桥 (events.publish → GlobalBus, 注入 location.directory) |
| `event-manifest.ts` | 重新导出 schema/event-manifest |
| `patch/index.ts` | apply_patch 工具 (Hunk schema + Add/Delete/Update) |

**协议**: `opencode/packages/protocol/src/groups/fs.ts:57-194` `FileSystemGroup` 注册 9 端点 (read/list/find/stat/write/mkdir/remove/rename/watch). 注意 `write` 是 base64-encoded (`groups/fs.ts:115-127`).

**fs watcher**: `opencode/packages/core/src/filesystem/watcher.ts:19-37` 懒加载 `@parcel/watcher` 原生 binding (mac: fs-events / linux: inotify / win: windows), 200ms 防抖 → `file.watcher.updated` SSE 事件 (`schema/src/filesystem-watcher.ts:6-12`).

**构建**: `bun run packages/opencode/script/build.ts --single --skip-install`. `--single` 只构建当前平台; `NUMAS_WEB_DIST` 环境变量指向 numas web 静态产物, 直接内嵌 (替代 `packages/app` build). 产物: `dist/opencode-<os>-<arch>/bin/opencode` (~200MB).

### 内置拓展能力

| 能力 | 来源 | 入口 |
| --- | --- | --- |
| 文件浏览/编辑 | codeblitz (内置) | explorer + monaco |
| 终端 PTY | opencode (远程 spawn shell) | `sumi/src/service/terminal.ts` |
| AI chat | opencode 全局 SDK | `sumi/src/extensions/chat/` (Chat.tsx 1844 行) |
| 工作目录切换 | 内置 UI (logo 旁按钮 + picker modal) | `extensions/actions/ActionsView.tsx:210-241` + `WorkspacePicker` |
| PDF 阅读 | **内置** + **vsix 备选** | `sumi/src/extensions/pdf/PdfReaderView.tsx` (2014 行) / `extensions/pdf/` (registry) |
| HTML 预览 | **仅 vsix** | `extensions/html/` (registry) |
| Paper 试卷 | **仅 vsix** | `extensions/paper/` (registry) |
| 打开方式/默认编辑器 | 内置重写 (覆盖 OpenSumi 3 个 bug) | `extensions/opentype/module.ts` (253 行) |
| 文件树 watcher | opencode 服务端 `@parcel/watcher` SSE | `service/fs.ts:711-760` |
| 标注 (rect → AI) | 内置 | `extensions/pdf/AnnotPopover.tsx` + `AnnotationActions.tsx` (309 行) |

### 端口

| 端 | 默认 | 说明 |
| --- | --- | --- |
| opencode web (集成模式) | **24096** | dev.js 默认; `--port <n>` / `NUMAS_PORT` 改 |
| webpack devServer (独立模式) | 7788 | `sumi/webpack.config.js:242`; `WEB_PORT` 改; dev.js 集成模式不起 |
| vsix registry | 7790 | `registry/src/server.js:21`; `NUMAS_REGISTRY` 改; 手动启 |

### dev.js 启动流程

```
0. Node ≥ 20 检查
1. sumi deps 自检自装 (npm install --ignore-scripts, hash marker)
2. opencode-ai 全局 binary 自检自装 (npm i -g, 兜底)
3. [dead code] watchexec 自检自装 (brew/apt/PowerShell) — 实际未用
4. killPort(24096) (lsof -ti :24096)
5. sumi build (npm run build, hash 命中则跳过)
6. mirror cp sumi/dist → opencode/packages/app/dist (mtime+size 增量)
7. opencode build (bun run script/build.ts --single --skip-install, NUMAS_WEB_DIST=sumi/dist, hash 命中则跳过)
8. spawn opencode web --hostname 0.0.0.0 --port 24096 --cors * --registry <url> (detached pgid=-pid)
9. SIGINT/SIGTERM cleanup (kill -pgid)
10. 4s 后 spawn open / cmd /c start / xdg-open http://localhost:24096
```

**注意**: 第 3 步装 watchexec 是 dead code — 客户端零 watch 进程, 全部在 opencode 服务端 (`@parcel/watcher`). 待清理.

### 命令行参数

| Flag / Env | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` / `NUMAS_PORT` | 24096 | opencode web 端口 |
| `--registry <url>` / `NUMAS_REGISTRY` | http://127.0.0.1:7790 | vsix registry |
| `--fast` / `NUMAS_FAST=1` | off | 跳过 sumi build / cp / opencode build (复用 5-10s → 1-2s) |
| `--force-build` | off | 强制重 build, 忽略 hash |

---

## 约定 / 禁忌

- **直连无代理**: client → opencode 之间不加 HTTP 中间层
- **CJK 路径 encodeURI**: HTTP header 必须 ISO-8859-1, `x-opencode-directory` 需 `encodeURI()`
- **单一事实源**: 端口 / CORS / APP_BASE_URL 由 dev.js 控制, 透 process.env 注入. 不要散落
- **平台兼容**: fs 命令按 host 平台分流 (mac/linux=POSIX, win=PowerShell); shell 走 `/pty/shells` 探测; **路径处理细则见 [铁律 7](#7-跨平台路径铁律) — 所有路径拼接走 `sumi/src/infra/path.ts` 工具函数, 禁止硬编码前导 `/` 与 `\\` 分隔符**
- **单一职责**: 每个模块只做一件事
- **配置外置**: 敏感信息不入库
- **中文优先**: 文档/接口/文案中文为主
- **品牌**: Numas (牛马 AI) — 打工人首选工作模式. 文档/banner 体现这调性
- **临时文件统一放 `.tmp/`** (项目根, 已在 .gitignore): 日志/截图/临时数据/调试产物全部进 `.tmp/`. **禁止**写到 `/tmp/` (散落难追踪) 或项目其他目录 (污染源码). 后台进程 `&> .tmp/<name>.log` 是标准写法
- **AI agent 操作造成的 stray 零容忍** (本规则对上条的强制版本):
  - playwright mcp 截图/落盘 `filename` 一律**绝对路径** `.tmp/<name>.png`
  - 任何 `> file` / `tee file` / 截图工具的输出, 落盘路径必须在 `.tmp/` 下
  - 每次写完一组操作**必须自检** `git status --short` + `ls .tmp/` 确认没有散落到项目根或子目录的 stray 文件
  - 发现 stray 立刻 `mv` 到 `.tmp/` (mv 不算"破坏性操作")

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](./README.md) | 给用户看的终态架构 + 快速开始 + CLI + FAQ |
| [docs/架构设计.md](./docs/架构设计.md) | 架构总览 + 6 张架构图 + 11 节 |
| [docs/功能清单.md](./docs/功能清单.md) | 已落地功能勾选清单 |
| [docs/文件系统设计与测试用例.md](./docs/文件系统设计与测试用例.md) | fs 设计 (DynamicRequest read + WriteSyncFS write + OverlayFS) + 验收 26 用例 |
| [docs/标注功能设计与测试用例.md](./docs/标注功能设计与测试用例.md) | PDF 标注设计 + AI ask popover + 批注演示 |
| [opencode/AGENTS.md](./opencode/AGENTS.md) | opencode fork 内部开发约定 (Effect-TS / 模块 shape / 测试 / typecheck) |