# AGENTS.md — Magicbook 项目 AI 协作约定

> AI agent 速查表。修改前先看「项目速写」「分层思想」「约定 / 禁忌」再动手。

## 项目速写

`magicbook` 是 C/S（客户端/服务器）架构可交互工作台，系统分两层：

| 子工程 | 职责 | 协议标准 |
| --- | --- | --- |
| `servers/` | 服务端：3 套协议标准的服务端实现 | agent（assistant）/ registry（registry）/ fss（filesystem） |
| `client/` | 客户端：基于 opensumi/codeblitz 的交互层 | registry / assistant / filesystem |

## 关键文件位置

```
magicbook/
├── package.json          # 顶层编排: dev/build（servers + client）
├── servers/              # 服务端（3 套协议标准实现）
│   ├── agent/            # assistant 协议: opencode serve 服务端
│   ├── registry/         # registry 协议: opensumi ext-host 协议服务器
│   └── fss/              # filesystem 协议: 文件系统 API
├── client/               # 客户端（opensumi/codeblitz）
│   └── webapp/
│       ├── src/
│       │   ├── core/        # 内核: commands / config / styles
│       │   ├── services/    # 3 套标准协议客户端: registry / assistant / filesystem
│       │   └── extensions/  # 拓展: actions / chat
```

## 关键命令

```bash
# 根目录 (magicbook/)
npm install
npm run dev              # servers + client 并发启动
npm run build            # 生产构建
```

## 分层思想

> 系统采用 **C/S 架构**，只分 2 层：servers（服务端）与客户端（webapp/）；跨层只通过 **3 套协议标准**（registry / assistant / filesystem）交互。

- **servers/** = 3 套协议标准的服务端实现（agent/registry/fss）；**协议标准是契约，服务个数只是部署形态**。
- **client/webapp/services/** = 3 套标准协议客户端（registry/assistant/filesystem），与 servers 一一对应。
- 服务端对客户端只暴露 3 个配置：`REGISTRY_BASE_URL` / `OPENCODE_BASE_URL` / `FS_BASE_URL`。
- 内核只定义接口与配置，不承载实现；服务只实现协议客户端与对接外部；拓展只消费能力与渲染，不直连服务端。

## 约定 / 禁忌

- 设计事实源：根目录用户稿图（`系统设计-用户稿图.md`）——命名与分层以稿图为准，不映射任何具体实现现状。
- 跨层只通过 3 套协议标准交互，禁止跨层直连。
- 单一职责：每个模块只做一件事，不跨模块堆逻辑。
- 配置外置：`REGISTRY_BASE_URL` / `OPENCODE_BASE_URL` / `FS_BASE_URL` 等配置抽成独立配置，不散落代码里。
- 敏感信息不入库。
- 中文优先：文档、接口说明、用户可见文案以中文为主。

## 验证清单（改完跑）

```bash
cd magicbook
# servers: 各协议服务可启动、接口可通
# client: tsc --noEmit 通过
```

## 任务执行

按上级 [`../AGENTS.md`](../AGENTS.md) 的「核心决策规则」与「标准工作流程」执行；本文件的项目级约束优先。

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 建立项目骨架：servers/client 两层，按用户稿图设计思想初始化文档 | 整个仓库 |

## 常见问题与修复（踩坑速查）

> 本会话积累的修复记录，改相关模块前先查这里。

### 文件系统（client → fs 服务 :24097）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `.opencode` 等目录显示为文件 | FileType 常量错（1/2） | 用 BrowserFS 枚举：FILE=32768 / DIRECTORY=16384 |
| 宿主机改文件编辑区不更新 | OverlayFS InMemory 缓存遮蔽 server 内容 | RemoteFS 读写全直连 server（无缓存）；外部事件 fireFilesChange 转 opensumi |
| 宿主机文件被循环写回 | fireFilesChange → onDidChangeFiles 钩子互触发 | 不挂 onDidChangeFiles/onDidCreateFiles（backend 直落）；只留 onDidSaveTextDocument 兜底 |
| 保存报 FileIsOutOfSync | Stats 未传 mtime（每次 Date.now()） | toStats 传 server mtime（Date.parse），保存时 lastModification 稳定 |
| readFile 报 Buffer.from undefined | globalThis.Buffer 不存在 | `import { Buffer } from 'buffer'`（codeblitz 依赖内，非 node: 前缀） |
| explorer「无打开的文件夹」 | 挂载时 fsUrl 未就绪（登录前）或 workspaceDir 不匹配 | workspaceDir='/'；RemoteFS 根目录 stat 兜底返回空目录（登录后刷新填充） |

### 终端（client → pty_base_url = opencode :24096）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| Cannot find Provider of ITerminalServicePath | opensumi 终端后端服务缺失 | service/terminal.ts 注册（useClass，非 useFactory——否则 @Autowired 无 injector） |
| script 伪 TTY 立即退出 | script 需要自身 stdin 是 TTY（tcgetattr） | 不用 script；pty_base_url = opencode（node-pty，跨平台） |
| opencode ws connect 500 | directory 用相对路径（/workspace） | connect 不带 directory；cwd 用绝对路径（GET /path 的 directory） |
| 终端输出夹杂 `{"cursor":0}`/`{"method":"resize"}` JSON | opencode 控制帧 | 过滤：去 `\u0000` 前缀 + 跳 cursor/resize（含 `"method"` 的 JSON 帧） |
| 输入被 JSON 污染（shell 收到字面量） | resize 等控制帧走 onMessage fallthrough 发给 shell | onMessage 只转发 `{data}` 文本，其余 JSON 忽略 |
| 默认 shell 不对（应为 zsh） | client 写死 /bin/bash | /sandbox 返回 default_shell（宿主机事实），client 直接用（不调 /path） |
| 终端创建早于登录（ptyUrl 未注入） | applyRuntime 时序 | waitPtyReady（等 runtime-ready 事件，超时兜底） |
| 输出回调无效（xterm 空白） | 回调目标应是 browser 侧 ITerminalService（onMessage） | @Autowired(ITerminalService) 注入，输出调其 onMessage/closeClient（as any） |

### registry / vsix 扩展（:7781，HTTPS，kt-ext）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| ext host 读 `pkgNlsJSON['zh-CN']` 崩溃 | 元数据缺 codeblitz 字段 | build 生成完整 IExtensionBasicMetadata：defaultPkgNlsJSON/pkgNlsJSON/nlsList/extendConfig/webAssets/mode='local'/uri |
| 扩展资源 404 | kt-ext uri 拼了 /extension/dist 前缀 | uri = `kt-ext://<host>/<id>`（解压内容根，animbook 布局） |
| ERR_CERT_AUTHORITY_INVALID | 自签证书未系统信任 | 自签带 SAN（DNS:localhost, IP:127.0.0.1）+ `sudo security add-trusted-cert`（系统钥匙串；Chrome 不认用户钥匙串） |
| vsicons 等内置资源被重写到 registry | StaticResource resolve 覆盖了原 host | resolve 保留 uri.authority（只 kt-ext→https），registry 扩展与内置市场各自命中 |
| 扩展完全不加载（main 不拉取） | 扩展 host 未启动（默认 noExtHost: true）或 ITaskService 缺失 | 不设 noExtHost（默认 web 扩展走 worker）；modules 加 TaskModule（@opensumi/ide-task） |
| customEditor 不匹配（.paper 用文本打开） | 无语言注册 | contributes.languages 注册扩展名（id + extensions）；activationEvents 必须与 viewType 完全一致（如 onCustomEditor:magicbook.paperEditor） |
| `__PAPER_MANIFEST__ is not defined` | esbuild 直接跑没注入 define | 用项目的 esbuild.config.mjs（define __PAPER_MANIFEST__ = webview vite manifest） |
| vsix 必须 browser 兼容 | codeblitz 纯浏览器，main 只在 node | package.json 声明 browser 字段（main 别名）；bundle 禁 node builtins（fs/path 等） |

### 架构要点

- 沙箱相关：/sandbox 只返回地址（fs/pty/opencode/base_shell）+ 管理生命周期（opencode/fs 探活自启）；registry 由 client 编译期配置（.env REGISTRY_BASE_URL）
- 独立服务：fs :24097 / opencode :24096 / registry :7781；未来容器化一体（+registry :24098），ingress subdomain 路由
- 扩展源码：`server/extensions/<name>/`（入库）；产物（vsix/dist/uploads）归 registry（gitignore）
- 扩展加载机制：metadata 注入 → customEditor 打开触发 onCustomEditor 激活 → 拉 browser 入口 → provider 注册 → resolve
