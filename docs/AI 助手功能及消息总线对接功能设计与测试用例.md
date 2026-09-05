# AI 助手拓展设计:消息总线接入 (SSE 收敛)

> 本篇只讲**事件通道改造**: AI 助手拓展 (chat 面板) 把会话消息事件从"自建 SSE + 轮询重连"改为消费[消息总线](./消息总线服务设计与测试用例.md). 聊天 UI / 消息渲染 / 会话管理逻辑不变。

## 1. 设计说明

### 1.1 整体设计

**现状**: `extensions/chat/webview/Chat.tsx` 在一个 `useEffect` 里 (`Chat.tsx:460-699`):

- 自建 `EventSource('/global/event')` (`subscribeV1Events()` 把 onmessage 包成异步迭代器);
- `run()` 循环 `for await` 消费事件, 跑一个大 switch 处理 `session.status` / `session.idle` / `message.part.updated` / `message.part.delta` / `message.updated` / `message.removed` / `session.updated` / `question.asked` / `todo.updated` / `permission.updated` / `permission.replied`;
- 流结束 (`for await` 退出) 后 `setTimeout(run, 3000)` 轮询重连兜底; cleanup 里 `es.close()`。

这套自建 SSE + 异步迭代器 + 3s 重连与 ports 重复 (同样在自建 EventSource), 且迭代器/重连样板代码复杂。ask 命令的事件消费独立, 详见[无头ask命令功能设计](./无头ask命令功能设计与测试用例.md)。

**改造**: 删除自建 EventSource / 异步迭代器 / `run()` 循环 / 3s 重连定时器, effect 内改为订阅消息总线 `onEvent(handler)`:

- 总线把每一帧归一化为 `{ type, properties, directory }`; `handler` 里**原样复用**现有大 switch 逻辑 (把 `ev.type` / `ev.properties` 喂进去即可)。
- `session.status` / `session.idle` 的**全局 busy 对账**逻辑保留 (不按当前会话过滤, 防止切走期间 idle 丢失导致 busy 悬挂)。
- 保留: 订阅前 `refreshSessionStatuses()` 对账一次; 15s 定时 `refreshSessionStatuses()` 校准 (`Chat.tsx:707-710`) 不变 —— 总线虽自动重连, 对账作为丢事件兜底仍有价值。
- cleanup: 调 `onEvent` 返回的 `unsub()`。

### 1.2 设计原则

- **只换事件源, 不动业务**: 大 switch 的每一分支 (打字机 upsert / busy / question 卡 / permission 卡 / 标题同步) 逻辑原样保留, 降低回归面。
- **全局事件不按会话过滤**: `session.status` / `session.idle` 仍对所有会话处理 (busy map 全局维护), 其余事件按 `properties.sessionID === sessionIDRef.current` 过滤。
- **去掉手写重连**: EventSource 自动重连由总线统一负责; 不再有 3s 轮询重连。busy 对账 (初始 + 15s) 作为事件丢失的校正手段保留。
- **事件风暴防护不变**: 仅在 `session.idle` 时触发一次 `loadMessages` 最终同步, 不在高频事件里发 HTTP (沿用原注释告诫, 防 `ERR_INSUFFICIENT_RESOURCES`)。

### 1.3 核心链路

```
[opencode] 会话消息事件 → GlobalBus → /global/event SSE
      ↓
[消息总线 eventBus] (唯一 SSE)
      ↓ onEvent(handler)
[Chat.tsx effect]
      ├─ session.status / session.idle → 全局 busy map (idle 时对当前会话 loadMessages 一次)
      └─ 其余 (按 properties.sessionID 过滤当前会话):
           message.part.updated  → upsert part (text/reasoning/tool/...)
           message.part.delta    → 追加 delta 打字机
           message.updated       → 用户消息占位替换 / upsert
           message.removed       → 移除行
           session.updated       → 标题同步
           question.asked        → 提问卡
           permission.updated/replied → 权限卡展开/收起
           todo.updated          → 无操作 (todo 卡片已呈现)
```

**改造点对照**:

| 原实现 | 改造后 |
| --- | --- |
| `new EventSource('/global/event')` | 删除, 由总线持有 |
| `subscribeV1Events()` 异步迭代器 + 队列 | 删除, 直接 `onEvent(cb)` |
| `run()` + `for await` + `setTimeout(run, 3000)` | 删除, 总线自动重连 |
| `es.close()` cleanup | `unsub()` cleanup |
| 帧解析 `raw.payload \|\| raw` / `props \|\| data` | 总线已归一化, 直接用 `ev.type` / `ev.properties` |
| 大 switch 业务分支 | **原样保留** |
| 初始 + 15s `refreshSessionStatuses()` | **保留** |

## 2. 验收标准

### 2.1 事件通道

1. `Chat.tsx` 内**不再出现** `new EventSource` / 异步迭代器 / `setTimeout(run` 3s 重连。
2. 会话消息经总线到达: 发消息后打字机流式增量正常, 消息完整、无重复 (尤其不出现"你好你好"式占位叠加)。
3. 与端口面板同时使用时, Network 中 `/global/event` 仅一条 (chat 与 ports 共用同一条 SSE, 由消息总线归一)。

### 2.2 流式与 busy 回归

1. AI 回复逐字呈现 (`message.part.delta`); `message.part.updated` upsert 不丢非 text part (reasoning/tool/step)。
2. 生成中显示停止按钮 (busy), `session.idle` 后消失; 切到别的会话再切回, busy 不悬挂。
3. `session.idle` 时对当前会话触发一次 `loadMessages` 最终同步; 高频 delta 事件不触发 HTTP (无请求洪流)。
4. 初始订阅 + 每 15s 的 `refreshSessionStatuses()` 对账仍执行 (断连/丢事件后 busy 被校正)。

### 2.3 卡片交互回归

1. `question.asked` → 消息流内出现提问卡 (A2UI), 可交互, 无弹窗。
2. `permission.updated` → 权限卡 (once/always/reject) 弹出; `permission.replied` → 卡片收起。
3. `session.updated` → AI 生成真实标题后 banner 标题同步 (占位"新会话"被替换)。
4. `message.removed` / 用户消息本地占位替换为真实 id 等行为正常。

### 2.4 生命周期

1. 组件 unmount → `unsub()` 生效, 不再收到事件回调 (无 setState on unmounted 警告)。
2. `ready` (agentUrl/client 就绪) 翻转时重新订阅; `ready=false` 时不订阅。

## 3. 执行记录

> 执行日期: <待填>; 环境: dev (opencode 24096 + webpack 7788);
> 执行方式: chat 多轮对话 + 工具权限/提问卡交互 + 切换会话 + DevTools Network 核对单条 SSE。

| 用例 | 结果 | 备注 |
| --- | --- | --- |
| 2.1-1 | ⏳ | Chat.tsx 无 new EventSource / 无 3s 重连 |
| 2.1-2 | ⏳ | 打字机流式完整无重复 |
| 2.1-3 | ⏳ | 与端口面板共用 /global/event 仅一条 |
| 2.2-1 | ⏳ | delta 逐字 + updated 不丢 part |
| 2.2-2 | ⏳ | busy/停止按钮/切回不悬挂 |
| 2.2-3 | ⏳ | idle 单次 loadMessages, 无 HTTP 洪流 |
| 2.2-4 | ⏳ | 初始 + 15s busy 对账保留 |
| 2.3-1 | ⏳ | question 提问卡 |
| 2.3-2 | ⏳ | permission 卡弹出/收起 |
| 2.3-3 | ⏳ | 标题同步 |
| 2.3-4 | ⏳ | message.removed / 占位替换 |
| 2.4-1 | ⏳ | unmount unsub 无泄漏回调 |
| 2.4-2 | ⏳ | ready 翻转重订阅 |
