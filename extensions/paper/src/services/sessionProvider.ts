/**
 * Session provider — src/services/sessionProvider.ts
 *
 * 启动期探测运行环境 (sumi-edu CodeBlitz 容器 vs standalone VS Code),
 * sumi-edu 模式下订阅 sumi-edu.login.subscribe-session-change 维护当前用户会话缓存,
 * 供 http.ts 在 buildHeaders 时同步读取 token/sign/partner 注入请求头.
 *
 * 公共 API:
 *   - initialize(context):  activate 调一次, 同步探测 + 启动订阅循环, 并把
 *                            dispose 推入 context.subscriptions (extension 卸载时自动清理)
 *   - getCurrentSession():   同步读取当前会话快照 (null = 未登录 / standalone)
 *   - getEnvironment():     同步读取当前环境 ('sumi-edu' | 'standalone' | 'initializing'),
 *                            供 extension.ts 决定 scope 加载源 (app/.env vs globalState)
 *   - onSessionChange(cb):  订阅会话变化, **不**立即触发, 只在 cache 更新时调用
 *   - dispose():            deactivate 调, 取消订阅 + 清空 listeners
 *
 * 类型与 sumi-edu/src/commands/login/types.ts 字段保持一致 (source of truth).
 * 跨仓不直接 import, 后续如需共享可抽到独立 type-only package.
 * 字段可选 (`?:`) 与 sumi-edu 保持一致, 保持契约向前兼容.
 *
 * 跨 realm IPC 约束:
 *   - subscribe-session-change 命令不能返回函数字段 (函数字段会被 structuredClone 剥掉)
 *   - 因此 sumi-edu 端拆出 3 条数据-only 命令: subscribe / next / unsubscribe
 *   - 本模块内部把 3 条命令 wrap 回 CleanupToken+pull 的 `{ unsubscribe, next }` 形态,
 *     保持内部 API 优雅, 屏蔽 IPC 序列化细节
 *
 * 状态时序 race 处理:
 *   - 场景: VSIX 在 extension host 激活, 但 sumi-edu 启动期的 bootstrapLogin() 可能早已完成
 *     (window.sumi.userSession 已是 authenticated). 此时订阅表为空时 notifySubscriptionChange no-op,
 *     VSIX 第一个 next() 永远等不到状态.
 *   - 解决: sumi-edu subscribe-session-change 原子化返 { token, initialState }, 本模块立即消费
 *     initialState 设 _state, 后续 loop 走正常的 drain 语义.
 *
 * 已知限制:
 *   - standalone VS Code 模式 _state 永久 null (无 .env fallback)
 *   - 订阅循环只能中断一次 (dispose 后 next() reject 'subscription cancelled' 退出 loop)
 *   - 单次 activation 有效, deactivate 释放
 */

import * as vscode from 'vscode';

// ─── 类型本地重定义 (字段对齐 sumi-edu/src/commands/login/types.ts) ─

export type UserSession = {
  nickname?: string;
  userId?: string;
  avatar?: string;
  token?: string;
  sign?: string;
  partner?: string;
};

export type UserSessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; session: UserSession }
  | { status: 'unauthenticated' };

/**
 * VSIX 内部使用的订阅句柄 — CleanupToken+pull 形态.
 * 内部通过 3 条 IPC-safe 命令 (`subscribe-session-change` + `next-session-change` +
 * `unsubscribe-session-change`) 桥接, 调用方无需关心 IPC 序列化约束.
 */
export type SubscribeSessionChangeResult = {
  unsubscribe: () => void;
  next: () => Promise<UserSessionState>;
};

/** sumi-edu 命令总线返的纯数据句柄 (函数字段会被 IPC 剥掉, 不可暴露 unsubscribe / next). */
type SubscribeSessionChangeHandle = {
  token: number;
  /** 订阅时刻的 state snapshot. 用于处理 "VSIX 在 bootstrapLogin() 已完成后才订阅" 的 race. */
  initialState: UserSessionState;
};

export type Environment = 'sumi-edu' | 'standalone' | 'initializing';

// ─── 命令 id 常量 ───────────────────────────────────────────────────
// source of truth: sumi-edu/src/commands/login/commands.ts (LOGIN_CMD)

const CMD_GET_SESSION = 'sumi-edu.login.get-session';
const CMD_SUBSCRIBE_SESSION_CHANGE = 'sumi-edu.login.subscribe-session-change';
const CMD_NEXT_SESSION_CHANGE = 'sumi-edu.login.next-session-change';
const CMD_UNSUBSCRIBE_SESSION_CHANGE = 'sumi-edu.login.unsubscribe-session-change';

// ─── 模块级状态 ─────────────────────────────────────────────────────

let _environment: Environment = 'initializing';
let _state: UserSession | null = null;
let _listeners: Set<(s: UserSession | null) => void> = new Set();
let _subscriptionHandle: SubscribeSessionChangeResult | null = null;

/**
 * 提取会话字段. loading/unauthenticated → null, authenticated → state.session.
 */
function extractSession(state: UserSessionState): UserSession | null {
  return state.status === 'authenticated' ? state.session : null;
}

/**
 * 同步缓存更新 + 通知所有 listeners. 异常隔离: 单个 listener 抛错不影响其他.
 */
function syncCacheAndNotify(next: UserSession | null): void {
  _state = next;
  for (const cb of _listeners) {
    try {
      cb(next);
    } catch (e) {
      // 异常隔离: 单个 listener 抛错不影响其他
      console.warn('[sessionProvider] listener threw:', e);
    }
  }
}

/**
 * 探测运行环境. 同步 try executeCommand('sumi-edu.login.get-session'):
 *   - 成功 → 'sumi-edu'
 *   - 抛 command-not-found → 'standalone'
 *   - 其他错误 → 'standalone' + console.warn
 *
 * 用 get-session 而非 subscribe-session-change 做探测:
 *   get-session 同步立即返回, 更适合能力检测.
 */
async function detectEnvironment(): Promise<Environment> {
  try {
    await vscode.commands.executeCommand(CMD_GET_SESSION);
    return 'sumi-edu';
  } catch (e) {
    // command-not-found 或其他错误 → standalone
    console.warn('[sessionProvider] detectEnvironment failed, assuming standalone:', e);
    return 'standalone';
  }
}

/**
 * 启动订阅循环 (sumi-edu 模式). 一次性创建 subscription, 串行 await next() 链.
 *
 * 串行而非并发: session 变化频率低, 串行足; cleanup 简单 (dispose 检查 handle 一致性).
 *
 * IPC 桥接: subscribe-session-change 返 { token, initialState }; 内部把 `next-session-change` +
 * `unsubscribe-session-change` 两条命令 wrap 回 CleanupToken+pull 的 `{ unsubscribe, next }` 形态.
 *
 * Race 处理: 立即消费 initialState 设 _state, 解决 "VSIX 在 bootstrapLogin() 已完成后才订阅" 时序坑.
 *
 * 错误处理:
 *   - subscribe executeCommand 抛错 → console.warn, 切到 standalone
 *   - next() reject 'subscription cancelled' → 静默退出 loop (预期, unsubscribe 触发)
 *   - next() reject 'subscription not found' → 静默退出 loop (意外, unsubscribe 后才 next)
 *   - next() reject 其他错误 → console.warn, 退出 loop (避免重连抖动)
 *   - next() resolve loading → 不更新 cache (保持上一次, 首次为 null)
 *   - next() resolve authenticated → cache = session, notify
 *   - next() resolve unauthenticated → cache = null, notify
 */
async function startSubscription(): Promise<void> {
  let handle: SubscribeSessionChangeHandle;
  try {
    handle = await vscode.commands.executeCommand<SubscribeSessionChangeHandle>(
      CMD_SUBSCRIBE_SESSION_CHANGE
    );
  } catch (e) {
    console.warn('[sessionProvider] subscribe failed, falling back to standalone:', e);
    _environment = 'standalone';
    _state = null;
    return;
  }

  const { token, initialState } = handle;

  // Race 处理: 立即消费 initialState (订阅时刻的 state snapshot).
  // 覆盖 "bootstrapLogin 已完成, VSIX 后激活" 场景 — 之前 loop 会永远 hang 等变化.
  if (initialState.status !== 'loading') {
    syncCacheAndNotify(extractSession(initialState));
  }
  // status=loading 时不更新 _state (保持 null), 后续 loop 第一次 next() 会拿到下一个真实 state.

  // Wrap 2 条 IPC 命令回 CleanupToken+pull 形态. 调用方对 token/IPC 细节无知.
  const subscriptionHandle: SubscribeSessionChangeResult = {
    unsubscribe: () => {
      // fire-and-forget; next() 若已被 cancel, 后续会 reject 'subscription cancelled' 退出 loop.
      // 用 then(undefined, onRejected) 而非 .catch — VS Code 的 Thenable 没有 .catch 方法.
      vscode.commands
        .executeCommand(CMD_UNSUBSCRIBE_SESSION_CHANGE, { token })
        .then(undefined, (e: unknown) => {
          console.warn('[sessionProvider] unsubscribe threw:', e);
        });
    },
    // Promise.resolve(Thenable) 包一层把 VS Code 的 Thenable 升级为标准 Promise,
    // 避免调用方类型契约 (`Promise<UserSessionState>`) 与 Thenable 不匹配.
    next: () =>
      Promise.resolve(
        vscode.commands.executeCommand<UserSessionState>(CMD_NEXT_SESSION_CHANGE, { token })
      ),
  };

  _subscriptionHandle = subscriptionHandle;
  const myHandle = subscriptionHandle;

  // 串行 await 链. 退出条件: _subscriptionHandle !== myHandle (被 dispose 替换)
  void (async () => {
    while (_subscriptionHandle === myHandle) {
      try {
        const next = await myHandle.next();
        if (next.status === 'loading') {
          // loading 状态: 不更新 cache, 继续 loop
          continue;
        }
        syncCacheAndNotify(extractSession(next));
      } catch (e) {
        // subscription cancelled (unsubscribe 已调) 或其他错误, 退出 loop
        if (
          e instanceof Error &&
          (e.message === 'subscription cancelled' ||
            e.message === 'subscription not found (already unsubscribed or never existed)')
        ) {
          // 预期, 静默退出
          return;
        }
        console.warn('[sessionProvider] next() rejected, exiting loop:', e);
        return;
      }
    }
  })();
}

// ─── 公共 API ───────────────────────────────────────────────────────

/**
 * 启动期入口. activate 调一次, 同步完成环境探测 + (sumi-edu 模式) 启动订阅循环.
 *
 * 调用结束后会把 `dispose()` 包装为 Disposable 推入 `context.subscriptions`,
 * extension 卸载时由 VS Code 自动调用, **无需** activate 端再持有 handle.
 *
 * @param context VS Code ExtensionContext, 仅用于 `context.subscriptions.push`
 */
export async function initialize(context: vscode.ExtensionContext): Promise<void> {
  _environment = await detectEnvironment();
  if (_environment === 'sumi-edu') {
    await startSubscription();
  } else {
    _state = null;
  }
  // 推 disposable 到 extension context, 卸载时自动 dispose
  context.subscriptions.push(new vscode.Disposable(() => dispose()));
}

/**
 * 同步读取当前会话缓存. http.ts 在 buildHeaders 调用.
 *
 * @returns 已鉴权时为 UserSession, 否则 null (loading / unauthenticated / standalone)
 */
export function getCurrentSession(): UserSession | null {
  return _state;
}

/**
 * 同步读取当前环境. extension.ts 在 initialize 之后调, 决定 scope 加载源.
 *
 * @returns 'sumi-edu' | 'standalone' | 'initializing' (initialize 未调过时为 initializing)
 */
export function getEnvironment(): Environment {
  return _environment;
}

/**
 * 订阅会话变化. **不立即调用** callback (避免 callback 内同步依赖未初始化).
 *
 * @returns Disposable, deactivate 时 dispose
 */
export function onSessionChange(cb: (s: UserSession | null) => void): vscode.Disposable {
  _listeners.add(cb);
  return new vscode.Disposable(() => {
    _listeners.delete(cb);
  });
}

/**
 * 反初始化. 取消订阅 + 清空 listeners + 重置缓存.
 *
 * 幂等: 多次调用等价于一次.
 */
export function dispose(): void {
  if (_subscriptionHandle) {
    try {
      _subscriptionHandle.unsubscribe();
    } catch (e) {
      console.warn('[sessionProvider] unsubscribe threw:', e);
    }
    _subscriptionHandle = null;
  }
  _listeners.clear();
  _state = null;
  _environment = 'initializing';
}
