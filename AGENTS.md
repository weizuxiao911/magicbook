# AGENTS.md — AI 工作台 项目 AI 协作约定

> AI agent 速查表。修改前先看「项目速写」「分层思想」「约定 / 禁忌」再动手。

## 项目速写

`AI 工作台` 是 C/S（客户端/服务器）架构可交互工作台。系统分两层：

| 端 | 目录 | 职责 |
| --- | --- | --- |
| 客户端 | `client/` | opensumi/codeblitz 交互层（explorer / 编辑器 / 终端 / 聊天 / 扩展） |
| 服务端 | `sandbox/` | 统一入口: /ai 透传、/fs 文件系统、/workspace 调度、/sandbox 信息 |
| 服务端 | `registry/` | vsix 扩展分发（HTTPS, kt-ext） |
| 扩展 | `extensions/` | vsix 扩展源码（html-preview / paper） |

## 关键文件位置

```
AI 工作台/
├── package.json            # 顶层编排: dev（sandbox + client 并发启动）
├── .env.development        # 唯一配置: APP_BASE_URL / REGISTRY_BASE_URL
├── sandbox/                # 服务端（tsx 运行）
│   └── src/
│       ├── main.ts         # 入口: /ai 透传 + ws upgrade、/sandbox、/health、启动兜底清孤儿
│       ├── routes/         # ai（反向代理）/ fs（文件系统）/ workspace（browse/ensure/select）
│       └── service/        # opencode（探活/自启/清理）/ fswatch
├── registry/               # 扩展分发: build → metadata.json + 静态资源（:7790）
├── client/                 # 客户端（opensumi/codeblitz）
│   └── src/
│       ├── core/           # 内核: config / commands
│       ├── service/        # sandbox / agent / fs / terminal / registry 实现
│       └── extensions/     # chat / workspace / login / actions 等
└── extensions/             # 扩展源码: html-preview / paper
```

## 关键命令

```bash
# 根目录
npm install
npm run dev              # sandbox（tsx watch :7789）+ client（webpack-dev-server :7788）并发启动
cd registry && npm run dev   # 扩展分发独立启动（:7790, 自签 HTTPS）

# 验证
cd client && npm run typecheck   # tsc --noEmit
```

## 分层思想

> 系统采用 **C/S 架构**，客户端只配置一个入口 `APP_BASE_URL`（.env.development 编译期注入）。
> 下游服务地址**全部由 APP_BASE_URL 派生**，不配置第二个地址。

- `sandbox/` = 服务端唯一入口（:7789）：`/ai/*` 全量反向代理到 opencode（含 ws upgrade），`/fs/*` 内置文件系统实现，`/workspace/*` 目录调度，`/sandbox` 信息接口。
- **opencode = `${APP_BASE_URL}/ai`**；**终端 PTY 同址 = `${APP_BASE_URL}/ai/pty`**（无独立 pty_base_url）；**fs = `${APP_BASE_URL}/fs`**。
- `opencode :24096` 由 sandbox 独家调度（探活/自启），**非默认启动**，只有选中工作目录（APP_CWD）后才拉起。
- `registry` 是唯一例外：编译期独立配置 `REGISTRY_BASE_URL`。
- 跨层只通过协议交互；内核只定义接口与配置，不承载实现；服务只实现协议客户端与对接外部；拓展只消费能力与渲染。

## 约定 / 禁忌

- 只有 `APP_BASE_URL` 一个服务地址配置入口，下游地址一律派生（/ai、/fs），禁止散落其他 base url。
- 跨层只通过协议交互，禁止跨层直连。
- 单一职责：每个模块只做一件事，不跨模块堆逻辑。
- 配置外置：敏感信息不入库。
- 中文优先：文档、接口说明、用户可见文案以中文为主。
- sandbox 以 **tsx（node）** 运行（bun 下 http-proxy ws 握手会卡死）；opencode 生命周期由 sandbox 管理，不手动拉起。

## 验证清单（改完跑）

```bash
cd sandbox && npm run dev        # 服务可启动、/ai /fs /sandbox 接口可通、opencode 拉起
cd client && npm run typecheck   # tsc --noEmit 通过
```

## 任务执行

按上级 `../AGENTS.md`（用户级）的「核心决策规则」与「标准工作流程」执行；本文件的项目级约束优先。

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 建立项目骨架（原 magicbook 仓库结构整理: servers 目录移除, 扩展/webview 配置上移） | 整个仓库 |
| 本次重构 | 统一 APP_BASE_URL 派生架构; sandbox tsx 运行 + /sandbox 信息接口 + opencode 逃逸加固; 终端走 /ai/pty; question 多问题 tab | sandbox/client |

## 常见问题与修复（踩坑速查）

> 本会话积累的修复记录，改相关模块前先查这里。

### 终端（client → app_base_url/ai/pty）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 终端创建失败（cannot create ptyInstance） | 旧逻辑读 ptyUrl（pty_base_url 已废弃, 为空） | 终端 base = app_base_url/ai（opencodeBaseUrl 派生, terminal.ts） |
| 终端 ws 一直 CONNECTING / loading | sandbox 用 bun 跑, http-proxy 的 proxy.ws 握手卡死 | sandbox 改用 **tsx（node）** 运行 |
| 创建后立即输入抛 WebSocket CONNECTING send | create2 返回时 ws 未 open | create2 等 ws open（3s 超时兜底）+ onMessage readyState 防御 |
| 默认 shell 变成 bash | applyRuntime 未注入 default_shell | server /sandbox 按 process.platform 返回; client 终端懒加载 /sandbox 注入（macOS zsh） |
| opencode 逃逸（kill -9 sandbox 后残留） | spawn 用 detached+unref, 清理只靠 exit 信号 | 整进程组 SIGKILL（kill(-pgid)）+ pkill 同步化 + 启动兜底 cleanupOrphanOpencode |
| 502 偶发（重启后） | opencode 由 sandbox 调度, 非默认启动 | agent SDK 请求带 X-Current-Cwd header → sandbox 幂等 ensure；client get() 有 APP_CWD 时自动初始化 |

### 文件系统（client → app_base_url/fs）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `.opencode` 等目录显示为文件 | FileType 常量错（1/2） | 用 BrowserFS 枚举：FILE=32768 / DIRECTORY=16384 |
| 宿主机改文件编辑区不更新 | OverlayFS InMemory 缓存遮蔽 server 内容 | RemoteFS 读写全直连 server（无缓存）；外部事件 fireFilesChange 转 opensumi |
| 宿主机文件被循环写回 | fireFilesChange → onDidChangeFiles 钩子互触发 | 不挂 onDidChangeFiles/onDidCreateFiles（backend 直落）；只留 onDidSaveTextDocument 兜底 |
| 保存报 FileIsOutOfSync | Stats 未传 mtime（每次 Date.now()） | toStats 传 server mtime（Date.parse），保存时 lastModification 稳定 |
| readFile 报 Buffer.from undefined | globalThis.Buffer 不存在 | `import { Buffer } from 'buffer'`（codeblitz 依赖内, 非 node: 前缀） |
| explorer「无打开的文件夹」 | 挂载时 fsUrl 未就绪（登录前）或 workspaceDir 不匹配 | workspaceDir='/'；RemoteFS 根目录 stat 兜底返回空目录（登录后刷新填充） |

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

- 唯一配置：`.env.development` 的 `APP_BASE_URL`（client 编译期注入）；下游地址全部派生（/ai、/fs），opencode 与终端同址 `/ai`。
- 服务端口：client :7788 / sandbox :7789 / opencode :24096（sandbox 拉起）/ registry :7790。
- opencode 生命周期：sandbox 独家调度（/workspace/ensure|select 或带 X-Current-Cwd 的请求触发幂等 ensure）；启动兜底清孤儿 + 整进程组清理防逃逸。
- 扩展源码：`extensions/<name>/`（入库）；产物（vsix/dist/uploads）归 registry（gitignore）。
- vsix 开发规范（用户约定）: **一律 TypeScript**（`src/extension.ts` + esbuild → `dist/extension.js`）;
  **webview 单独维护**（`webview/` 目录或 `webview.tsx`, 不内联拼 HTML 字符串）;
  **publisher 统一 `weizuxiao911`**（用户生产的 vsix 统一使用账号名）;
  **vsix 文件名规范 `{发布者}.{拓展名称}-{版本}.vsix`**（如 `weizuxiao911.magicbook-html-preview-0.1.0.vsix`, 由 vsce 打包默认生成）;
  项目统一 MIT 开源协议（根 LICENSE）
- 扩展加载机制：metadata 注入 → customEditor 打开触发 onCustomEditor 激活 → 拉 browser 入口 → provider 注册 → resolve

### 待优化交互体验问题（登记）

| 问题 | 现象 | 期望 | 备注 |
| --- | --- | --- | --- |
| 编辑器拆分布局刷新后空分组无法关闭 | 拆分 2 个区域后刷新，新增分组（右 group）无 tab 且无法关闭；空分组不自动让出宽度 | 分组为空时自动关闭/让出宽度，其他分组铺满 main 区域 | 根因在 opensumi 恢复的 group 状态（backend 建 tab 未加载、close 被卡）；曾尝试 client 恢复拆分结构（fs.ts），方向复杂已放弃；后续可从「检测空/异常 group 自动 dispose」或「恢复后清理无渲染 group」入手 |
