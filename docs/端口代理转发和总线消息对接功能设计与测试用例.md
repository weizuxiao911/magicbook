# PTY 服务跟踪与消息接入设计

> 端口面板两大块: (a) PTY 启动服务跟踪 + 反代 (仿 VS Code 零维护); (b) 事件通道改造 (端口开/关事件收敛到全局消息总线)。
> 共同数据契约: `PortEntry` (port/pid/process/cwd/detectedAt), 共同生命周期: PTY `create` → `registerPid(pid)` → 3s 周期 scan → SSE → 面板。

---

## 1. 设计说明

### 1.1 整体结构

```
opencode 服务端                                     numas 客户端
─────────────────                                   ─────────────────
PTY create                                          [extensions/ports/PortsPanel.tsx]
   ↓ proc.pid                                          ├─ mount → portsService.subscribe(cb)
portsService.registerPid(pid)                         │              ↓
   ↓                                                   │        [message bus 总线]
trackedPids: Set<number>                              │     onEventType(['ports.detected',
   ↓                                                   │                 'ports.closed'], h)
3s 周期 scan (BFS 进程树 + lsof/netstat)              │              ↓
   ├─ POSIX: pgrep -P + lsof -a -p PID               │     ports.service 内 handler
   └─ Win:   netstat -ano + Get-CimInstance           │     ├─ 更新 cached (去重/排序/移除)
   ↓                                                    │     └─ fan-out → cb({type, port, process})
diff → emit ports.detected / ports.closed              │
   ↓ (GlobalBus.publish)                               └─ list 渲染 + notification (mount 才弹)
/global/event SSE (唯一)  ──────────────────────────► 消息总线 eventBus (sumi)
                                                          ├─ 引用计数 EventSource
                                                          ├─ onEvent / onEventType / onSessionEvent
                                                          └─ 多模块共享 1 条 SSE
   ↓
/proxy/:port/:rest (isKnown → trackedPids ∪ whitelist)
   ├─ WS upgrade → HttpApiProxy.websocket
   └─ HTTP → HttpApiProxy.http (流式, 透传 content-type)
```

### 1.2 设计原则

- **仿 VS Code `autoForwardPortsSource: "process"`**: 端口面板默认不扫宿主, 只跟踪 numas 自身 spawn 进程树 (PTY create 是当前唯一入口). 零名单维护
- **PTY 是单一注册入口**: PTY `create` 成功立刻 `PortsService.registerPid(ptyPid)`; `onExit` 时 `unregisterPid`. 注册/反注册与 PTY 生命周期严格对齐. 未来 Agent bash/process 工具可作第二入口, 走同一 registerPid 通道
- **白名单保留为"非 PTY 来源"兜底**: 用户手动转发宿主机非 numas spawn 的端口 (裸 `node server.js` 等), 走原 `POST /ports` 流程
- **事件源唯一**: 端口开/关事件只从[消息总线](./消息总线服务设计与测试用例.md)取, `ports.service.ts` 不再持有 EventSource. chat / ask / ports 三模块共享 1 条 SSE
- **对外 API 不变**: `IPortsService.subscribe(cb)` 签名 + 回调载荷 `{type, port, process?}` 不变, 面板零改动
- **反代与 isKnown 不变**: `/proxy/:port/*` 五方法 + WS upgrade + `isKnown` 校验 + 目标 127.0.0.1 + 超时/流式透传全部沿用, 不重新设计
- **服务启动通知按面板可见性收敛**: 通知只对打开面板的用户有效; 面板未开 → 不推送 `ports.detected` notification. `ports.closed` 不打扰 (与 PTY 跟踪原则一致)
- **名称备注先 localStorage**: `localStorage["ai-ports-labels"]: Record<port, label>`, 全局不分 workspace, 简化首版; 后续若需跨设备升级为 `.vscode/portsAttributes.json` 镜像
- **完全删除** `IGNORE_PROCESS` / `ALWAYS_EXCLUDE` (旧 ports.ts:42,45): 只跟踪 numas 自身 spawn, 无需名单

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

### 1.4 事件通道改造 (SSE 收敛到消息总线)

**改造前**: `service/ports/ports.service.ts` 的 `subscribe()` 内部自建一条 `EventSource('/global/event')` (`ensureSse/closeSse`, ports.service.ts:89-119), 只过滤 `ports.detected` / `ports.closed`, 维护 `cached` 列表并 fan-out 给订阅者. 这与 chat / ask 各自的 SSE 重复.

**改造**: 端口面板的事件消费改由总线驱动.

- 删除 `ports.service.ts` 里的 `sse` 字段 / `ensureSse()` / `closeSse()` / `new EventSource(...)`
- `subscribe(cb)` 内部改为调用总线 `onEventType(['ports.detected', 'ports.closed'], handler)`:
  - `handler` 里保留原有缓存更新逻辑 (detected 去重插入 + 按端口排序; closed 移除), 组装 `{ type, port, process }` 后 fan-out 给 `subscribe(cb)` 的监听者
- 面板 (`extensions/ports/PortsPanel.tsx`) 与其余端口逻辑**完全不变**: 仍是 `portsService.subscribe(cb)` 拿事件、`scan/list/add/remove/proxyUrl/registerPid/unregisterPid` 走原 HTTP 封装
- SSE 连接从 ports.service **上移到消息总线**, ports.service 只保留非 SSE 的业务 (HTTP 增删查 + 缓存). 面板 mount/unmount 的订阅生命周期不变 (unmount 调 unsub → 总线引用计数归 0 时关连接)

**改造后 subscribe 形态** (示意):

```ts
subscribe(cb): () => void {
  this.listeners.add(cb);
  const off = onEventType(['ports.detected', 'ports.closed'], (ev) => {
    const type = ev.type as 'ports.detected' | 'ports.closed';
    const port = Number(ev.properties.port);
    if (!port) return;
    const process = ev.properties.process as string | undefined;
    // 更新 cached (沿用原逻辑)
    if (type === 'ports.detected') {
      if (!this.cached.some((e) => e.port === port)) {
        this.cached = [...this.cached, { port, process, detectedAt: Date.now() }]
          .sort((a, b) => a.port - b.port);
      }
    } else {
      this.cached = this.cached.filter((e) => e.port !== port);
    }
    this.listeners.forEach((l) => l({ type, port, process }));
  });
  return () => {
    this.listeners.delete(cb);
    off();
  };
}
```

### 1.5 端口数据 Schema (沿用 `PortEntry`, 不变)

```ts
class PortEntry extends Schema.Class<PortEntry>("Ports.Entry")({
  port: Schema.Number,
  pid: Schema.Number.pipe(Schema.optional),
  process: Schema.String.pipe(Schema.optional),
  cwd: Schema.String.pipe(Schema.optional),    // 内置浏览器 PDF 拦截 → file:// 路径还原用
  detectedAt: Schema.Number,
}) {}
```

PID 来源是 numas spawn 树; `process` 字段填顶层 PID 的 command 前 15 字符 (沿用 `lsof` 截断); `cwd` 字段由后端 lsof/readlink /proc 探测 (POSIX, Windows 留空).

**名称备注 localStorage**:
- key: `ai-ports-labels` (全局, 不分 workspace, 简化首版)
- value: `Record<number /* port */, string /* label */>`
- 仅 UI 层用, 不传到后端; 反代 URL 与服务端 schema 无影响

---

## 2. 验收标准

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
2. 反代返回 200 (目标服务正常) → 浏览器渲染该服务页面
3. 反代返回 502 / 404 (目标未启动 / 非 HTTP) → 浏览器展示 opencode 反代的错误 body, 面板**不**报错 (打开动作本身成功)
4. WS upgrade 反代: 打开 Vite HMR 端口 (启动 vite 项目后) → 浏览器 DevTools Network 应见 `/proxy/<port>/` 101 Switching Protocols 帧; HMR 工作正常
5. 未白名单且非 PTY 跟踪端口访问 `/proxy/<port>/` → 404 `port <port> not known` (防 SSRF 兜底保留)
6. `proxyUrl(port)` 拼接 baseUrl (sumi `appBaseUrl()`) + `/proxy/<port>/` 必须 `replace(/\/+$/, '')` 去尾斜杠, 防止 base 含尾斜杠拼成 `//`

### 2.6 SSE / 通知

1. 面板 mount → 启动 SSE 订阅 (复用 `service/ports/ports.service.ts` 的 `subscribe` API); mount 立即调一次 `GET /ports` 拉快照
2. 面板 unmount → SSE 订阅 unsubscribe (原 listener 数 = 0 时 closeSse)
3. 面板未挂载 → 后端即使 emit `ports.detected`, 前端不弹 notification (无订阅者)
4. `ports.closed` 事件 → 仅更新列表, **不弹** notification

### 2.7 事件通道改造 (SSE 收敛)

1. `service/ports/ports.service.ts` 内**不再出现** `new EventSource` / `ensureSse` / `closeSse`
2. 端口事件经总线到达: 面板开着时, 终端起服务能收到 `ports.detected`, 停掉收到 `ports.closed`
3. 与对话面板/提问命令同时使用时, Network 中 `/global/event` 仅一条 (共享总线)

### 2.8 面板功能回归 (沿用 PTY 跟踪, 验证事件通道改造后无回归)

1. 内置终端 `python3 -m http.server 8000` → 面板 ≤5s 出现 `:8000` + 通知; Ctrl+C 后 ≤8s 移除
2. 手动添加 / ✕ 删除端口、名称备注 (localStorage `ai-ports-labels`)、反代打开 (`/proxy/<port>/`) 全部正常
3. 面板未挂载时不弹通知 (panel-only 订阅语义不变); mount 时立即 `scan()` 拉一次快照

### 2.9 订阅生命周期

1. 面板 mount → 订阅; unmount → 取消订阅
2. 端口面板是唯一订阅者且其卸载后, 若总线引用计数归 0 则 SSE 关闭; 再次 mount 自动重建
3. 回调载荷 `{type, port, process?}` 与改造前一致, 面板无类型/字段错误

### 2.10 回归与边界

1. 旧的 `notify` notification 文案 (服务启动提示) 删除后, 终端启动 dev server 仍能在底部面板 (打开时) 看到 + 弹通知
2. 跨工作区切换: localStorage 名称备注仍生效 (跨 workspace 共用 key); PTY 跟踪在新 workspace 重新跟踪 (旧 workspace 的 PTY 反注册后自动消失)
3. 同一端口在多个工作区同时跟踪 (例如 A/B 两个工作区都有 dev server 在 :3000): 列表单行, process 显示最新一次启动的进程
4. PTY 子进程产生大量短命端口 (如 :3000 立刻关闭 重新起 :3001): 列表不抖动, 每端口一条稳定行, closed 即移除
5. opencode 子进程 (control-plane remote workspace / `--port <n>` 子 opencode) **不得**出现在列表 (不在 numas spawn 树中, scan 自动跳过)
6. 反代目标服务异常 (如 :3000 已关闭, 但白名单未移除) → 反代 502, 面板按钮仍可点 (用户能快速诊断), 不自动移除
7. dev 二级实例 (`opencode --port 24097` 作为 24096 的 child, AGENTS.md control-plane 模式) 同上不出现
8. macOS / Linux 跨平台验证 (主流程); Windows 留接口 (`TODO`), 不阻塞本次合并

---

## 3. 执行记录

> 执行日期: <待填>; 环境: dev (opencode 24096 + webpack 7788);
> 执行方式: playwright 操作 PTY + 端口面板 + 宿主机 `lsof`/`netstat` 对照 + 反代 curl + localStorage + Network 单条 SSE 验证.

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
| 2.7-1 | ⏳ | ports.service 无 new EventSource |
| 2.7-2 | ⏳ | detected/closed 经总线到达 |
| 2.7-3 | ⏳ | 三功能同用 /global/event 仅一条 |
| 2.8-1 | ⏳ | http.server 检测/移除 + 通知 |
| 2.8-2 | ⏳ | 增删/备注/反代正常 |
| 2.8-3 | ⏳ | 未挂载无通知 + mount 拉快照 |
| 2.9-1 | ⏳ | mount 订阅 / unmount 取消 |
| 2.9-2 | ⏳ | 计数归 0 关闭 / 重建 |
| 2.9-3 | ⏳ | 回调载荷字段一致 |
| 2.10-1 | ⏳ | 旧通知文案删除后面板正常 |
| 2.10-2 | ⏳ | 跨 workspace 备注 + PTY 重启 |
| 2.10-3 | ⏳ | 多 workspace 同端口单行 |
| 2.10-4 | ⏳ | 短命端口不抖动 |
| 2.10-5 | ⏳ | opencode 子进程不出现在面板 |
| 2.10-6 | ⏳ | 反代失败面板按钮保留 |
| 2.10-7 | ⏳ | dev 二级实例不出现 |
| 2.10-8 | ⏳ | macOS/Linux 主流程 (Windows 留 TODO) |