# AI 工作台

> 浏览器端可交互工作台（本地模式）。`codeblitz` 全局交互容器 直连 `opencode` 后端，`registry` 提供 vsix 扩展分发。
> `npx github:weizuxiao911/magicbook` 一行启动。

## 架构总览

```mermaid
graph TB
    subgraph Browser["🌐 浏览器 (client/)"]
        UI["codeblitz 容器<br/>(explorer/编辑器/终端/聊天)"]
        FS["fs 服务<br/>读: 全局 API<br/>写: FsPty 单例 PTY"]
        SDK["SDK 直连<br/>(无中间代理)"]
        UI --> FS
        UI --> SDK
    end

    subgraph Backend["⚙️ opencode (外部进程, cli 拉起)"]
        API["/api/fs/* /find/file<br/>(全局只读)"]
        PTY["/api/pty + WS<br/>(全局 PTY 通道)"]
        SHELL["/session/{id}/shell<br/>(仅供 chat agent)"]
        PWD["/path<br/>(host cwd + home)"]
    end

    subgraph Dist["📦 registry (独立进程)"]
        META["metadata.json"]
        VSIX["vsix 解压资源"]
    end

    SDK ==>|"fetch / WebSocket<br/>APP_BASE_URL"| API
    SDK ==>|"fetch / WebSocket"| PTY
    SDK -.->|"启动时拉"| META
    SDK -.->|"激活时拉"| VSIX

    classDef browser fill:#e3f2fd,stroke:#1976d2
    classDef backend fill:#fff3e0,stroke:#f57c00
    classDef dist fill:#f3e5f5,stroke:#7b1fa2
    class Browser browser
    class Backend backend
    class Dist dist
```

## 端口单一事实源 (cli)

```mermaid
graph LR
    A["🖥️ 用户<br/>cli --port 4000"] --> B["cli/bin/cli.cjs<br/>set process.env<br/>APP_BASE_URL"]
    B -->|"env 继承"| C["opencode serve<br/>:4000"]
    B -->|"env 继承"| D["webpack-dev-server<br/>:7788"]
    D -->|"编译期<br/>DefinePlugin"| E["__APP_BASE_URL__<br/>= http://127.0.0.1:4000"]
    E --> F["客户端 SDK<br/>直连 :4000"]
    C -.->|"响应"| F

    classDef user fill:#fff9c4
    classDef cli fill:#c8e6c9
    classDef server fill:#bbdefb
    classDef client fill:#f8bbd0
    class A user
    class B cli
    class C,D server
    class E,F client
```

| 端 | 默认 | cli flag | env var |
| --- | --- | --- | --- |
| opencode | 3100 | `--port` | `APP_BASE_URL` (= `http://127.0.0.1:<port>`) |
| webpack-dev-server | 7788 | `--client-port` | `CLIENT_PORT` |
| opencode 绑定地址 | 127.0.0.1 | `--hostname` | — |
| CORS allow-origin | 派生 | (auto, 跟 `--client-port`) | — |

## 数据流

### fs 读 (list / read / find / meta)

```mermaid
sequenceDiagram
    participant C as Client
    participant O as opencode

    C->>O: GET /api/fs/list?path=.<br/>x-opencode-directory: <cwd>
    Note over C,O: encodeURI 包装中文路径
    O->>O: 解析 cwd, 列目录
    O-->>C: { data: [{ path, type }] }
    Note over C,O: 0 中间层, 直连
```

### fs 写 (write / rm / mkdir / move / readBinary)

```mermaid
sequenceDiagram
    participant C as Client (FsPty)
    participant O as opencode (/api/pty + WS)

    Note over C: lazy init: 探测 /pty/shells
    C->>O: POST /api/pty { command: zsh, cwd }
    O-->>C: { id: pty_xxx }
    C->>O: WS /api/pty/{id}/connect
    Note over C,O: 全局 PTY, 单例
    C->>O: write cmd + UUID marker
    Note over C,O: promise chain 串行
    O-->>C: stdout (含 marker)
    C->>C: 截取 marker, 返回 { ok, output }
```

### terminal (用户开终端)

```mermaid
sequenceDiagram
    participant U as 用户
    participant T as terminal.ts
    participant O as opencode

    U->>T: create2()
    T->>O: POST /api/pty { command: zsh }
    O-->>T: { id }
    T->>O: WS /api/pty/{id}/connect
    Note over T,O: 每终端独立 session
    T-->>U: 渲染终端
    U->>T: 输入命令
    T->>O: ws.send(input)
    O-->>T: stdout
    T-->>U: 显示输出
```

## 组件

```mermaid
graph TB
    subgraph CLI["cli/ (进程编排器)"]
        BIN["bin/cli.cjs<br/>(npx 入口, 44 行)"]
        MAIN["src/main.ts<br/>(web/serve 路由)"]
    end

    subgraph CLIENT["client/ (浏览器)"]
        COMMANDS["src/commands/<br/>接口 + Token"]
        CONFIG["src/config/<br/>初始化/模块/布局"]
        SERVICE["src/service/<br/>8 实现"]
        EXT["src/extensions/<br/>chat/workspace/login/..."]
    end

    subgraph OPENCODE["opencode (外部)"]
        FS["/api/fs/*"]
        PTY["/api/pty + WS"]
        SHELL["/session/{id}/shell"]
    end

    subgraph REG["registry/ (独立)"]
        BUILD["build → metadata.json"]
        SERVE["serve :7790 HTTPS"]
    end

    BIN --> MAIN
    MAIN -->|spawn| OPENCODE
    MAIN -->|spawn webpack| SERVICE
    SERVICE --> FS
    SERVICE --> PTY
    EXT -.->|激活时加载| REG

    classDef cli fill:#c8e6c9
    classDef client fill:#bbdefb
    classDef opencode fill:#fff3e0
    classDef reg fill:#f3e5f5
    class BIN,MAIN cli
    class COMMANDS,CONFIG,SERVICE,EXT client
    class FS,PTY,SHELL opencode
    class BUILD,SERVE reg
```

| 端 | 目录 / 进程 | 职责 |
| --- | --- | --- |
| cli 编排器 | `cli/bin/cli.cjs` + `cli/src/main.ts` | npx 入口; 解析参数; 拉起 opencode + webpack 子进程; 进程组清理 |
| 客户端 | `client/` | codeblitz 容器 + 8 service + 4 内置 extension |
| 客户端 | `client/src/commands/` | 接口 + Token 定义 (IAgent/IRegistry/IFileSystem/IEnvService/IAuth) |
| 客户端 | `client/src/config/` | 初始化 / 模块注册 / 布局 / runtime config |
| 客户端 | `client/src/styles/` | CSS 覆盖 |
| 客户端 | `client/src/extensions/` | 拓展 (chat/workspace/login/actions/welcome) |
| 后端 | opencode (外部进程) | AI 推理 + 终端 PTY + 文件系统; cli 拉起的子进程 |
| 扩展 | `extensions/<name>/` | vsix 源码 (html-preview / paper) |
| 分发 | `registry/` (独立进程) | vsix 扩展分发 (build → metadata.json + 静态资源) |

## 启动方式

```mermaid
graph TD
    Start([用户]) --> Choice{选择启动方式}
    Choice -->|npx<br/>推荐| Npx["npx github:weizuxiao911/magicbook<br/>自动 clone + 装依赖 + 跑 bin"]
    Choice -->|git clone<br/>本地开发| Git["git clone ...<br/>npm install<br/>npm run dev"]
    Npx --> Mode{模式}
    Git --> Mode
    Mode -->|web<br/>默认| Web["启 opencode + webpack<br/>:3100 + :7788"]
    Mode -->|serve| Serve["只启 opencode<br/>:3100"]
    Web --> End([打开 http://localhost:7788])
    Serve --> End2([CLI 调用 API])

    classDef start fill:#fff9c4
    classDef npx fill:#c8e6c9
    classDef git fill:#bbdefb
    classDef mode fill:#f8bbd0
    classDef end fill:#d1c4e8
    class Start start
    class Npx npx
    class Git git
    class Mode mode
    class Web,Serve npx
    class End,End2 end
```

```bash
# 1. npx (推荐, 公共仓库)
npx github:weizuxiao911/magicbook
npx github:weizuxiao911/magicbook --port 4000          # opencode 4000
npx github:weizuxiao911/magicbook --client-port 8000   # webpack 8000
npx github:weizuxiao911/magicbook serve                # 只起 opencode

# 2. git clone (本地开发)
git clone https://github.com/weizuxiao911/magicbook
cd magicbook && npm install
cd cli && npm install && cd ..
cd client && npm install && cd ..
npm run dev
```

| 端 | 地址 | 说明 |
| --- | --- | --- |
| 工作台 | http://localhost:7788 | 浏览器入口 |
| opencode | http://127.0.0.1:3100 | AI + 终端 + 文件系统 |
| registry | https://127.0.0.1:7790 | 扩展分发 (需 `cd registry && npm run dev`) |

## 平台兼容

```mermaid
graph TD
    Start([fs 操作]) --> Detect{检测 host OS}
    Detect -->|navigator.platform| Mac["macOS<br/>zsh 优先"]
    Detect --> Linux["Linux<br/>bash 优先"]
    Detect --> Win["Windows<br/>powershell / pwsh"]

    Mac --> Probe["opencode /pty/shells<br/>取可用 shell 列表"]
    Linux --> Probe
    Win --> Probe

    Probe --> Pick{匹配平台}
    Pick -->|mac/linux| Posix["POSIX<br/>(bash / zsh / sh / fish)"]
    Pick -->|win| Ps["PowerShell<br/>(pwsh / powershell)"]
    Pick -->|fallback| Cmd["cmd.exe<br/>(部分操作支持)"]

    Posix --> Cmd2[("mkdir -p<br/>mv / rm -rf<br/>stat -c<br/>base64 -d")]
    Ps --> Cmd3[("New-Item -ItemType Directory<br/>Move-Item -Force<br/>Remove-Item -Recurse<br/>Get-Item")]
    Cmd --> Cmd4[("mkdir<br/>rmdir /S /Q<br/>move /Y<br/>(无 stat)")]

    classDef os fill:#e3f2fd
    classDef posix fill:#c8e6c9
    classDef ps fill:#fff3e0
    classDef cmd fill:#ffccbc
    class Mac,Linux,Win,Detect os
    class Posix,Cmd2 posix
    class Ps,Cmd3 ps
    class Cmd,Cmd4 cmd
```

| 平台 | shell | fs 命令 |
| --- | --- | --- |
| macOS | /bin/zsh (默认) / bash | `mkdir -p` / `mv` / `rm -rf` / `stat -c` / `base64 -d` |
| Linux | /bin/bash | (同上) |
| Windows | powershell / pwsh | `New-Item` / `Move-Item -Force` / `Remove-Item -Recurse` / `Get-Item` |
| Windows 兜底 | cmd.exe | `mkdir` / `rmdir /S /Q` / `move /Y` (无 stat) |

## 扩展机制

```mermaid
graph LR
    subgraph Source["extensions/&lt;name&gt;/ (源码)"]
        TS["src/extension.ts<br/>(TypeScript)"]
        WV["webview/<br/>(iframe UI)"]
    end

    TS -->|"esbuild<br/>(禁 node builtins)"| Bundle["dist/extension.js<br/>(browser 入口)"]
    WV -->|"vite build"| WV2["webview/<br/>(构建产物)"]

    Bundle --> VSIX["vsce package<br/>→ *.vsix"]
    WV2 --> VSIX

    VSIX -->|"放入<br/>registry/vsix/"| Reg["registry/<br/>build → metadata.json"]
    Reg --> Serve["HTTPS :7790<br/>(kt-ext)"]

    Serve --> Meta["metadata.json"]
    Meta -.->|启动时拉| Client["client/<br/>(加载元数据)"]
    WV2 -.->|激活时拉| Client

    Client --> Match{打开匹配文件}
    Match -->|.html| HP["html-preview 激活"]
    Match -->|.paper| PP["paper 激活"]
    HP --> Iframe["iframe 内运行<br/>用户 JS 可执行"]
    PP --> Iframe

    classDef src fill:#e3f2fd
    classDef bundle fill:#fff3e0
    classDef dist fill:#f3e5f5
    classDef client fill:#c8e6c9
    class TS,WV src
    class Bundle,WV2 bundle
    class VSIX,Reg,Serve dist
    class Client,Match,HP,PP,Iframe client
```

**扩展开发规范**:
- **一律 TypeScript** (`src/extension.ts` + esbuild → `dist/extension.js`)
- **webview 单独维护** (`webview/` 目录, 不内联拼 HTML)
- **publisher 统一 `weizuxiao911`**
- **vsix 文件名** `{发布者}.{拓展名称}-{版本}.vsix`
- **MIT** 开源协议

激活链路: `metadata → 打开文件 → onCustomEditor:<viewType> → 拉 browser 入口 → provider 注册 → resolve webview`

### 首次运行: 信任 registry 证书

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /Users/weizuxiao911/.../registry/certs/cert.pem
```

(证书已含 SAN: `localhost` + `127.0.0.1`)

## 目录

```
magicbook/
├── package.json            # 顶层 bin (cli) + dev/serve scripts
├── cli/                    # 进程编排器
│   ├── bin/cli.cjs         # npx 入口 (CommonJS, 44 行)
│   ├── src/main.ts         # web/serve 路由 + opencode/webpack 进程管理
│   └── package.json        # devDeps: tsx + typescript
├── client/                 # codeblitz 容器
│   ├── package.json        # deps + devDeps
│   ├── webpack.config.ts   # 内嵌; 端口读 process.env.CLIENT_PORT
│   ├── .env.development    # cli 不走时的兜底
│   ├── src/commands/       # 接口 + Token (平铺)
│   ├── src/config/         # 初始化 / 模块 / 布局 / runtime
│   ├── src/service/        # 8 实现
│   ├── src/extensions/     # chat / workspace / login / actions / welcome
│   └── src/styles/         # CSS
├── extensions/             # vsix 扩展源码 (html-preview / paper)
├── registry/               # vsix 扩展分发 (独立进程, :7790)
└── LICENSE                 # MIT
```

## 技术选型速览

| 层 | 选型 | 原因 |
| --- | --- | --- |
| npx 入口 | `cli/bin/cli.cjs` (CommonJS) | npx 调 .js 文件 (不能 TS), 必须 JS; 内部 spawn tsx 跑 TS |
| 进程编排 | `tsx` 统一 | 替代历史 ts-node, 启动快 ~300ms |
| 写操作 | 单例 PTY (FsPty) | 绕开 opencode session 单 shell 限制 (409) |
| 读操作 | opencode 全局 API | 轻量、高频, 无 session 限制 |
| 终端 | `/pty/{id}/connect` WS | 每终端独立 session, 不冲突 |
| 端口注入 | `process.env` | 单一事实源, cli → webpack → client 一条链 |
| 平台兼容 | `/pty/shells` 探测 + 平台分流 | macOS=zsh, Linux=bash, Windows=powershell |
| CJK 路径 | `encodeURI` header | HTTP header 限制 ISO-8859-1, 浏览器自动 |
| 依赖 | root 只 `tsx`, cli 只 `tsx`, client 全套 | 各管各, 互不污染 (-98% root size) |

## License

MIT
