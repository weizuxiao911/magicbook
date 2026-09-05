# 无头 ask 命令设计:workspace 修复 + 硬化

## 1. 设计说明

### 1.1 整体设计

**定位**: `extensions/ask/` 是**无头 (headless) 一次性 AI 通道** —— 给程序侧用 (不是给人聊天的面板). 任何拓展调 `ask(prompt, cb, opts)` 即可发起一次独立 AI 对话, 不污染 chat 历史. 当前唯一调用方是 PDF 标注的「生成动画」按钮 (`extensions/pdf/PdfReaderView.tsx:1112`)。

链路: `ask()` → 建独立 session → 发 prompt → 订阅[消息总线](./消息总线服务设计与测试用例.md)按 `sessionID` 过滤 → `session.idle` 拼完整文本回调 → 删 session。

**核心 bug (本次修复)**: 原 `AskService` 自建 `new EventSource('${base}/api/event')`, **既不带 `x-opencode-directory` header (EventSource 无法发 header), 也不带 `?directory=` query**:

- `/api/event` 挂在 `WorkspaceRoutingMiddleware` 之后, 缺 directory 时兜底路由到 **opencode 进程 cwd (numas 目录)** 那个 instance; handler (`handlers/event.ts:35-39`) 按 `event.location.directory === instance.directory` 过滤。
- ask 的会话用 SDK 创建, SDK 每请求带 `x-opencode-directory` = 用户工作区, 会话事件 location 是**用户工作区**。两 directory 不等 → 事件**全被过滤** → ask 永远收不到 `message.part.delta` / `session.idle` → 干等超时。
- 即 **用户工作区 ≠ numas 启动目录时 ask 完全失效**。命中铁律 8 (EventSource 不能发 header, 必须带 workspace 上下文)。

**修复方案**: ask 不再自建 SSE, 改订阅[消息总线](./消息总线服务设计与测试用例.md) (`/global/event` 全局流, 不按 workspace 路由) 的 `onSessionEvent(sessionID, ...)`, 从根上消除目录路由问题。同时做四项硬化:

1. **事件源改总线**: 删自带 EventSource, 用 `onSessionEvent` 按 `sessionID` 过滤; 终态 unsubscribe。
2. **目录单一事实源**: 不再 `client.path.get()` HTTP 探测目录, 改 `infra/url` 的 `effectiveCwd()`。
3. **临时会话用完即删**: 终态 (complete / error / cancel) 后 best-effort `client.session.delete({ sessionID })`, chat 会话列表不留痕。
4. **去掉看门狗**: 不设任何超时定时器。终态只有三种 —— `session.idle`(完成) / `session.error`(出错) / 用户 `cancel()`。长任务 (如大 HTML 动画生成) 不被误杀; 模型卡死由用户主动「取消」(`session.abort`)。

### 1.2 设计原则

- **一次性通道零残留**: 每次 ask 建独立 session, 用完即删; 不进 chat 会话列表, 不累积历史。
- **无看门狗 / 事件驱动终态**: 生成时长由模型决定, 客户端不臆断超时; 结束完全由总线事件 (`session.idle` / `session.error`) 或用户取消驱动。
- **单一事实源**: workspace 目录走 `effectiveCwd()`, 不自行探测; SSE 走消息总线, 不直连。
- **取消即终止**: `cancel()` = unsubscribe + `session.abort` (终止后端生成) + `session.delete`。
- **对外 API 不变**: `ask(prompt, callback, opts?)` 签名与 `AIRequestHandle` / `AIRequestCallbacks` 保持, PDF 调用方无需改调用方式 (仅移除其内部多余的超时兜底)。

### 1.3 核心链路

```
ask(prompt, cb, opts?)
  ↓ effectiveCwd() 取当前工作区 (单一事实源)
  ↓ SDK session.create({ location: { directory } })      ← header 带 workspace
  ↓ onSessionEvent(sessionId, handler)                   ← 订阅消息总线
  ↓ SDK session.promptAsync({ sessionID, parts:[text, ...images?] })
  ↓
[总线事件, 按 sessionID 过滤]
  message.part.delta (field='text') → 累积 text + onDelta(chunk)
  message.part.updated              → 全量 text 覆盖 (防 delta/updated 双计数)
  session.idle / session.status(idle) → onComplete(完整 text) → 删 session
  session.error                     → onError(...) → 删 session
  ↓
用户 cancel() → unsubscribe + session.abort + session.delete
```

**终态清理** (complete / error / cancel 统一):
- `unsubscribe()` 取消总线订阅;
- best-effort `client.session.delete({ sessionID })` (失败静默, 不影响主流程, 不报错给用户)。

**图片附件** (逻辑不变): `opts.images[]` (`{name, dataUrl}`) 转 `type:'file'` part (`mime` 从 dataUrl 前缀解析, `url` = dataUrl), 与 chat 附件一致。

**PDF 调用方清理** (`extensions/pdf/PdfReaderView.tsx` 的 `askWithCancel`):
- 移除 120s 兜底 `setTimeout` (那是第二层看门狗, 与"无看门狗"原则冲突, 长生成会被它误杀)。
- 保留: promise 包一层 (resolve onComplete / reject onError) + 记录 `generateReqRef` 供「取消」按钮调用。

**不改动**: `ask()` 函数签名; `requestAI` 兼容别名; images 组 part 逻辑。

## 2. 验收标准

### 2.1 任意工作区可用 (核心 bug)

1. 切到**非 numas 目录**工作区 (如 `?directory=/Users/foo/Documents/someproj`), 打开 PDF 圈选 → 「生成」: **不再超时报错**, 正常流式返回并生成动画。
2. DevTools Network: ask 触发期间**无** `/api/event` 连接。
3. ask 的 `onComplete` 收到非空完整 text; 控制台无超时类报错。
4. 在 numas 默认启动目录工作区下 ask 仍正常 (回归)。

### 2.2 临时会话用完即删

1. 一次 ask 完成后, chat 会话列表**不出现** ask 新建的临时会话。
2. ask 出错 / 用户「取消」两种终态后, 临时会话同样被删除 (best-effort, 删除失败不报错、不影响主流程)。

### 2.3 无看门狗

1. 源码中 `AskService` 无 `setTimeout` / `REQUEST_TIMEOUT_MS` / 看门狗逻辑。
2. 构造一次耗时较长的生成 (如要求生成复杂 HTML), 超过历史 90s/120s 阈值仍**不被切断**, 直到模型 `session.idle` 正常返回。
3. 模型卡死/不返回时, 用户点「取消」→ `session.abort` 生效, 生成终止并清理; 不存在自动超时。
4. `session.error` 事件到达时 → `onError` 触发并清理 (unsub + delete)。

### 2.4 取消

1. 生成中点「取消」→ 后端生成终止 (abort), 总线订阅解除, 临时会话删除。
2. 取消后 `onComplete` 不再被调用 (不产生迟到结果写入)。

### 2.5 流式与附件

1. `onDelta` 逐 chunk 回调 (打字机可用); `message.part.updated` 全量覆盖不产生重复文本。
2. 带 `opts.images` (PDF 页截图 dataUrl) 时, 作为 `type:'file'` part 发送, 模型能收到图片。

### 2.6 PDF 调用方

1. `PdfReaderView.tsx` 的 `askWithCancel` 无 120s `setTimeout` 兜底。
2. 「生成」成功 → 关 popover + 保存 html; 失败 → notification 提示; 「取消」按钮仍可终止。

## 3. 执行记录

> 执行日期: <待填>; 环境: dev (opencode 24096 + webpack 7788);
> 执行方式: 切非 numas 工作区触发 PDF 圈选生成 + DevTools Network/会话列表核对 + 构造长任务验证无超时。

| 用例 | 结果 | 备注 |
| --- | --- | --- |
| 2.1-1 | ⏳ | 非 numas 工作区生成成功不超时 |
| 2.1-2 | ⏳ | 无 /api/event 连接 |
| 2.1-3 | ⏳ | onComplete 非空, 无超时报错 |
| 2.1-4 | ⏳ | 默认工作区回归 |
| 2.2-1 | ⏳ | 完成后临时会话不入 chat 列表 |
| 2.2-2 | ⏳ | 出错/取消后会话删除 |
| 2.3-1 | ⏳ | AskService 无 setTimeout/看门狗 |
| 2.3-2 | ⏳ | 长任务 (>120s) 不被切断 |
| 2.3-3 | ⏳ | 卡死时手动取消 abort 生效 |
| 2.3-4 | ⏳ | session.error → onError 清理 |
| 2.4-1 | ⏳ | 取消 → abort + unsub + delete |
| 2.4-2 | ⏳ | 取消后无迟到 onComplete |
| 2.5-1 | ⏳ | onDelta 流式 + updated 不重复 |
| 2.5-2 | ⏳ | images file part 发送 |
| 2.6-1 | ⏳ | PDF askWithCancel 无 120s 兜底 |
| 2.6-2 | ⏳ | 成功关 popover / 失败通知 / 取消可用 |
