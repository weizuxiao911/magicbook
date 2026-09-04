# 端口面板设计:PTY 启动服务跟踪 (仿 VS Code 零维护)

## 1. 设计说明

### 1.1 整体设计

**问题**: 当前 numas 端口面板 (`extensions/ports/`) 默认扫描宿主机**全量 LISTEN** 端口并展示,造成 adb / Trae / opencode 自身子进程等无关端口 (本次现场扫到 10 个, 9 个与用户工作无关) 全部暴露, 需维护进程名正则白/黑名单 (`ports.ts:42-45` 的 `ALWAYS_EXCLUDE` + `IGNORE_PROCESS`) 才能"安静". 一旦新增 IDE/工具 (如 Trae Helper 进程名 `Trae\ H`) 就漏过滤, 用户被迫反复维护名单 — 不符合"零维护"承诺.

**方案**: 对齐 VS Code `autoForwardPortsSource: "process"` 语义, 端口面板**只跟踪 numas 主动 spawn 的进程** (当前入口: PTY 用户终端), **完全不扫宿主机全局 LISTEN**, 删除 `IGNORE_PROCESS` / `ALWAYS_EXCLUDE` 名单, 改为"用户主动添加的白名单"作为唯一的人工入口 (仿 VS Code `Forward a Port`). 端口反代 (`:24096/proxy/<port>/`) 与 isKnown (已知端口校验, 防 SSRF) 逻辑保留, `ports.detected` / `ports.closed` SSE 通道保留.

**核心要点**:
- **默认面板空** (VS Code 同款 "没有转发的端口. 转发端口以通过 Internet 访问本地运行的服务.")
- **跟踪对象**: numas (opencode 服务端) 主动 spawn 的 PTY 进程 + 其子进程递归 (POSIX: `pgrep -P` / `lsof -p`; Windows: `netstat -ano` + 进程树)
- **PID 注册入口**: opencode 服务端 PTY `create` 成功后立刻 `PortsService.registerPid(ptyPid)`; `onExit` 时 `unregisterPid`. 客户端 (sumi 浏览器侧) 无须感知 PID
- **服务发现/通知**: SSE `ports.detected` / `ports.closed` 由面板内订阅 (PortsNotifierContribution 默认订阅逻辑移除) — 面板未挂载时**不弹通知**, 避免噪音. 面板挂载后立即拉 `GET /ports` 一次补齐离线期间产生的事件
- **手动添加**: 面板顶部 input 输入端口号 → `POST /ports {port}` (原有端点保留) → 加入白名单 → 走 `isKnown`
- **名称备注** (Port Attributes 简化版): 面板每个转发条目支持 inline 编辑名称, localStorage 持久化 (`ai-ports-labels`); 与端口/进程名并列展示, 用于记忆服务语义
- **完全删除**: `IGNORE_PROCESS` / `ALWAYS_EXCLUDE` (ports.ts:42,45); 因为只跟踪 numas 自身 spawn, 不会再扫到宿主全局, 无需名单

### 1.2 设计原则

- **仿 VS Code `autoForwardPortsSource: "process"`**: 端口面板默认不扫宿主; 只跟踪自己 spawn 的进程. 零名单维护
- **PTY 是单一注册入口**: opencode 服务端 PTY `create` 是 numas 唯一允许的本地服务端口来源 (Agent bash/process 工具后续可作第二入口, 走同 registerPid 通道). 注册/反注册生命周期与 PTY 实例严格对齐
- **白名单保留为"非 PTY 来源"兜底**: 用户可手动转发宿主机非 numas spawn 的端口 (如裸 `node server.js` 写在外部脚本里的服务), 走原 `POST /ports` 流程
- **名称备注先 localStorage**: 不引入新 schema/storage 路由; 后续若需跨设备/项目级持久化再升级为 `.vscode/portsAttributes.json` 镜像
- **服务启动通知按面板可见性收敛**: 通知只对打开面板的用户有效; 面板未开 → 不推送 `ports.detected` notification (避免"猫叫声"). 面板开 → 推送 notification + 自动插入列表
- **反代与 isKnown 不变**: `/proxy/:port/*` 五方法 + WS upgrade + `isKnown` 校验 + 目标 127.0.0.1 + 超时/流式透传全部沿用, 不重新设计

### 1.3 核心链路

```
[opencode 服务端 PTY create] → proc.pid
     ↓
portsService.registerPid(pid)            ← Ref<Set<number>> add
portsService.scan (3s 周期, 跨平台)
  ├─ POSIX: pgrep -P 递归进程树 + lsof -p <pid> -a -iTCP -sTCP:LISTEN
  └─ Win:   netstat -ano + WMI/Cim 进程树
     ↓ diff → emit ports.detected/closed → GlobalBus → /global/event SSE
     ↓
[sumi 客户端] (仅当 PortsPanel mount 时 subscribe)
     ↓
PortsPanel 列表 + notification (notification.info, 8s, 点击 window.open 反代 URL)
     ↓
用户点击「转发端口」(输入端口号) → POST /ports → 白名单 → 列表出现 + isKnown true
     ↓
[反代打开] window.open(`${base}/proxy/${port}/`)
     ↓
[opencode 服务端 ports-route.ts /proxy handler]
  - isKnown(port)? = 在已注册 PID 扫描集 ∪ 白名单
  - target = 127.0.0.1:port (剥 /proxy/<port> 前缀)
  - WS upgrade → HttpApiProxy.websocket; 普通 → HttpApiProxy.http 流式
```

**PID 生命周期**:
- 注册: PTY `create` 拿到 `proc.pid` 后 `Effect.runFork(ports.registerPid(pid))`. 若 PID 已存在 (重复 create), 幂等
- 反注册: PTY `onExit` 触发时 `unregisterPid(pid)`. 进程可能仍存活 (子进程 detach), 但 numas 不再跟踪 — 与 VS Code 进程退出后停止 forward 一致
- 容错: 进程意外消失 (`/proc/<pid>` 查不到) → scan 时跳过该 PID

**跨平台进程树**:
- POSIX (mac/linux):
  - 子进程列表: `pgrep -P <pid>` 或 `ps -axo pid= --ppid <pid>` (linux); mac 自带 pgrep
  - LISTEN: `lsof -nP -p <pid> -a -iTCP -sTCP:LISTEN` 或合并 `lsof -nP -iTCP -sTCP:LISTEN` 按 pid 过滤
  - 递归: BFS, 设 maxDepth 16 防止失控
- Windows (本次不在主线验收, 留接口):
  - LISTEN: `netstat -ano` (已有 parse)
  - 进程父子: `wmic process where (ParentProcessId=<pid>) get ProcessId` 或 `Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"` (PowerShell)
  - 计划单独工单, 不阻塞本次合并

**端口数据 Schema** (沿用 `PortEntry`, 不变):
```ts
class PortEntry extends Schema.Class<PortEntry>("Ports.Entry")({
  port: Schema.Number,
  pid: Schema.Number.pipe(Schema.optional),
  process: Schema.String.pipe(Schema.optional),
  detectedAt: Schema.Number,
}) {}
```
PID 来源是 numas spawn 树; `process` 字段填顶层 PID 的 command 前 15 字符 (沿用 `lsof` 截断).

**名称备注 localStorage**:
- key: `ai-ports-labels` (全局, 不分 workspace, 简化首版)
- value: `Record<number /* port */, string /* label */>`
- 仅 UI 层用, 不传到后端; 反代 URL 与服务端 schema 无影响

## 2. 验收标准

以下操作均在打开 numas + 内置终端 (PTY) 的工作目录内完成验收.

### 2.1 默认面板空 (VS Code 同款)

1. 启动 numas (`npx numas`), 打开底部「端口」tab → 面板必须**为空**, 文案显示「没有转发的端口. 转发端口以通过 Internet 访问本地运行的服务.」+「转发端口」输入框 +「添加」按钮. 不得展示 adb / Trae / opencode 子进程等无关 LISTEN
2. 顶部标题栏不得出现 `N 个服务端口` 字样 (除非有手动添加/PTY 跟踪到的)
3. 后端 `GET /ports` 默认返回空数组 (无白名单, 无 PTY 启动), 前端亦不订阅 SSE (面板未挂载)
4. 删除 `IGNORE_PROCESS` / `ALWAYS_EXCLUDE` (ports.ts:42,45): 源码内不再包含 `Trae` / `adb` / `opencode` 等任何进程名正则字符串

### 2.2 PTY 启动服务跟踪

1. 内置终端执行 `python3 -m http.server 8000` → 终端输出 `Serving HTTP on :: port 8000`. 底部「端口」面板 mount 后, **≤ 5 秒内**列表自动出现 `:8000` (process=`python3` 或 `Python`)
2. 列表行展示 端口 / 进程名 / 打开 / 复制URL / ✕ / **名称备注 inline 编辑** (点击文本变 input, blur 保存到 localStorage)
3. 同时弹一条 `notification.info` "检测到服务 :8000 (python3)", 8s 自动消失; 点击通知 → `window.open` 打开反代 URL
4. 终端 `Ctrl+C` 停掉 http.server → **≤ 8 秒内**列表移除 `:8000`, 不弹关闭通知 (与设计原则一致: closed 不打扰)
5. 终端 `npm run dev` 启动 dev server (监听 :3000) → 列表 5s 内出现 `:3000`. dev server 内部子进程再启动的 worker 端口 (如有) 也应被跟踪 (递归进程树生效)
6. PTY 关闭 (点 ✕ 关闭终端面板) → 该 PTY spawn 的所有端口 ≤ 8 秒内全部从列表消失 (PID 反注册)
7. 同一端口被多个 PTY 启动 (race): 列表仅一行, 进程名取最新一次
8. PTY 启动端口 < 1024 (如 :80 需 root) → 仍然展示 (与原设计保持, 不强制过滤范围; 跟踪来源已是 numas 自身, 无需限制)

### 2.3 手动添加端口 (白名单)

1. 面板顶部「转发端口」输入 `3001` → 点「添加」 → 列表立即出现 `:3001`, 进程名显示「未知进程」或为空
2. `POST /ports {port: 3001}` 调用成功; 后端 `GET /ports` 包含 3001
3. 手动添加端口不依赖后端扫描 (即时入白名单, 走 isKnown); 不需要进程真实 LISTEN (用户可预先转发未启动的服务)
4. 输入无效端口 (`abc` / `0` / `99999`) → 添加按钮 disabled 或弹 notification 错误, 不污染白名单
5. 列表行点「✕」 → 调 `DELETE /ports/:port` + 本地状态移除, 后端 `GET /ports` 不再包含

### 2.4 名称备注 (Port Attributes 简化版)

1. 列表行右侧名称区域 (端口号后) 显示**当前名称** (默认取进程名前 12 字符或端口号字符串; 用户编辑后覆盖)
2. 点击名称区域 → 变 `<input>`, 自动 focus + select all, Enter 保存 / blur 保存 / Esc 取消恢复
3. 保存写入 `localStorage.ai-ports-labels[port] = label`; 列表实时刷新
4. 重新打开 numas → localStorage 名称恢复; 删除 localStorage key → 重置为默认 (进程名)
5. 名称备注同步在 notification 文案中: `检测到服务 :8000 [API Server]` (备注优先, 无备注回落进程名)
6. localStorage 损坏 (非 JSON) → 静默回退为空对象, 不阻断面板渲染

### 2.5 反代打开 (沿用 ports-route)

1. 列表行「打开」按钮 → `window.open(${base}/proxy/<port>/)`, 跳转到 opencode 反代 URL (新 tab)
3. 反代返回 200 (目标服务正常) → 浏览器渲染该服务页面
4. 反代返回 502 / 404 (目标未启动 / 非 HTTP) → 浏览器展示 opencode 反代的错误 body, 面板**不**报错 (打开动作本身成功)
5. WS upgrade 反代: 打开 Vite HMR 端口 (启动 vite 项目后) → 浏览器 DevTools Network 应见 `/proxy/<port>/` 101 Switching Protocols 帧; HMR 工作正常
6. 未白名单且非 PTY 跟踪端口访问 `/proxy/<port>/` → 404 `port <port> not known` (防 SSRF 兜底保留)
7. `proxyUrl(port)` 拼接 baseUrl (sumi `appBaseUrl()`) + `/proxy/<port>/` 必须 `replace(/\/+$/, '')` 去尾斜杠, 防止 base 含尾斜杠拼成 `//`

### 2.6 SSE / 通知

1. 面板 mount → 启动 SSE 订阅 (复用 `service/ports/ports.service.ts` 的 `subscribe` API); mount 立即调一次 `GET /ports` 拉快照
2. 面板 unmount → SSE 订阅 unsubscribe (原 listener 数 = 0 时 closeSse)
3. 面板未挂载 → 后端即使 emit `ports.detected`, 前端不弹 notification (无订阅者)
4. `ports.closed` 事件 → 仅更新列表, **不弹** notification

### 2.7 回归与边界

1. 旧的 `notify` notification 文案 (服务启动提示) 删除后, 终端启动 dev server 仍能在底部面板 (打开时) 看到 + 弹通知
2. 跨工作区切换: localStorage 名称备注仍生效 (跨 workspace 共用 key); PTY 跟踪在新 workspace 重新跟踪 (旧 workspace 的 PTY 反注册后自动消失)
3. 同一端口在多个工作区同时跟踪 (例如 A/B 两个工作区都有 dev server 在 :3000): 列表单行, process 显示最新一次启动的进程
5. PTY 子进程产生大量短命端口 (如 :3000 立刻关闭 重新起 :3001): 列表不抖动, 每端口一条稳定行, closed 即移除
6. opencode 子进程 (control-plane remote workspace / `--port <n>` 子 opencode) **不得**出现在列表 (不在 numas spawn 树中, scan 自动跳过)
7. 反代目标服务异常 (如 :3000 已关闭, 但白名单未移除) → 反代 502, 面板按钮仍可点 (用户能快速诊断), 不自动移除
8. dev 二级实例 (`opencode --port 24097` 作为 24096 的 child, AGENTS.md control-plane 模式) 同上不出现
9. macOS / Linux 跨平台验证 (主流程); Windows 留接口 (`TODO`), 不阻塞本次合并

## 3. 执行记录

> 执行日期: <待填>; 环境: dev (opencode 24096 + webpack 7788);
> 执行方式: playwright 操作 PTY + 端口面板 + 宿主机 `lsof`/`netstat` 对照 + 反代 curl + localStorage 验证.

| 用例 | 结果 | 备注 |
| --- | --- | --- |
| 2.1-1 | ⏳ | 默认空面板 + 提示文案 |
| 2.1-2 | ⏳ | 顶部标题无 N 个服务端口 |
| 2.1-3 | ⏳ | `GET /ports` 空 + SSE 默认未订阅 |
| 2.1-4 | ⏳ | 源码删 IGNORE_PROCESS / ALWAYS_EXCLUDE |
| 2.2-1 | ⏳ | `python3 -m http.server 8000` → 列表 ≤ 5s |
| 2.2-2 | ⏳ | 行布局完整 (端口/进程/操作/备注) |
| 2.2-3 | ⏳ | notification 自动弹 + 点击反代 |
| 2.2-4 | ⏳ | Ctrl+C 后 ≤ 8s 移除, 无 closed 通知 |
| 2.2-5 | ⏳ | `npm run dev` + worker 子端口递归 |
| 2.2-6 | ⏳ | PTY 关闭 → 端口 ≤ 8s 全消 |
| 2.2-7 | ⏳ | 多 PTY race → 单行 |
| 2.2-8 | ⏳ | < 1024 端口跟踪 |
| 2.3-1 | ⏳ | 手动添加 3001 → 即时入列 |
| 2.3-2 | ⏳ | POST /ports 成功 + GET /ports 含 3001 |
| 2.3-3 | ⏳ | 不依赖进程 LISTEN |
| 2.3-4 | ⏳ | 无效端口拒绝 |
| 2.3-5 | ⏳ | ✕ 移除 + DELETE 成功 |
| 2.4-1 | ⏳ | 名称区默认显示 |
| 2.4-2 | ⏳ | inline 编辑 + Enter/blur 保存 / Esc 取消 |
| 2.4-3 | ⏳ | localStorage.ai-ports-labels 写入 |
| 2.4-4 | ⏳ | 重启 numas 恢复 + 清空回退 |
| 2.4-5 | ⏳ | notification 备注优先 |
| 2.4-6 | ⏳ | localStorage 损坏静默回退 |
| 2.5-1 | ⏳ | 打开 → window.open 反代 URL |
| 2.5-2 | ⏳ | 200 反代渲染目标 |
| 2.5-3 | ⏳ | 502/404 反代不报错 |
| 2.5-4 | ⏳ | WS upgrade 101 + HMR |
| 2.5-5 | ⏳ | 未白名单 → 404 防 SSRF |
| 2.5-6 | ⏳ | proxyUrl 拼尾斜杠 |
| 2.6-1 | ⏳ | mount 订阅 + 拉快照 |
| 2.6-2 | ⏳ | unmount 取消订阅 |
| 2.6-3 | ⏳ | 未挂载无 notification |
| 2.6-4 | ⏳ | closed 不弹通知 |
| 2.7-1 | ⏳ | 旧通知文案删除后面板正常 |
| 2.7-2 | ⏳ | 跨 workspace 备注 + PTY 重启 |
| 2.7-3 | ⏳ | 多 workspace 同端口单行 |
| 2.7-4 | ⏳ | 短命端口不抖动 |
| 2.7-5 | ⏳ | opencode 子进程不出现在面板 |
| 2.7-6 | ⏳ | 反代失败面板按钮保留 |
| 2.7-7 | ⏳ | dev 二级实例不出现 |
| 2.7-8 | ⏳ | macOS/Linux 主流程 (Windows 留 TODO) |