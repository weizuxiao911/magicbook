/**
 * PortsService — 本地服务端口发现 (numas fork 增量, 全局单例)
 *
 * 对标 VSCode 端口面板 (autoForwardPortsSource: "process"):
 *   - 仅跟踪 numas 主动 spawn 的进程 (PTY / Agent 工具) 的子进程树 LISTEN 端口,
 *     不扫宿主全局 LISTEN, 无需维护进程名名单
 *   - 周期 (3s) 扫描: pgrep 递归 PID 树 → lsof/netstat 拿 LISTEN → diff emit
 *     (走 GlobalBus → /global/event SSE → codeblitz 面板)
 *   - 白名单 (POST /ports) 仍保留: 用户手动转发非 numas spawn 的端口
 *   - /proxy/:port/* 仅代理 "已知端口" (scanned + whitelist, 防 SSRF)
 *
 * 注册/反注册:
 *   - registerPid(pid): numas spawn 进程 (PTY create 后, Agent 工具 spawn 后) 调
 *   - unregisterPid(pid): 进程 exit 时调 (PTY onExit, Agent 工具退出)
 *
 * 自身端口 (opencode 24096 / control-plane 子 opencode): 排除, 永不展示
 */

import { Context, Effect, Layer, Ref, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { Process } from "@/util/process"

export class PortEntry extends Schema.Class<PortEntry>("Ports.Entry")({
  port: Schema.Number,
  pid: Schema.Number.pipe(Schema.optional),
  process: Schema.String.pipe(Schema.optional),
  detectedAt: Schema.Number,
}) {}

export class Service extends Context.Service<Service, Ports.Interface>()("@opencode/Ports") {}

export namespace Ports {
  export interface Interface {
    readonly snapshot: () => Effect.Effect<readonly PortEntry[]>
    readonly scan: () => Effect.Effect<readonly PortEntry[]>
    readonly whitelist: (port: number) => Effect.Effect<void>
    readonly remove: (port: number) => Effect.Effect<void>
    readonly isKnown: (port: number) => Effect.Effect<boolean>
    readonly registerPid: (pid: number) => Effect.Effect<void>
    readonly unregisterPid: (pid: number) => Effect.Effect<void>
    readonly trackedPids: () => Effect.Effect<readonly number[]>
  }
}

/** 进程树递归最大深度, 防失控 */
const MAX_TREE_DEPTH = 16
/** 进程树单步探测超时 (ms) */
const PROC_TREE_TIMEOUT = 3000

/** 取原始监听行 (跨平台, 失败静默). 仍然扫全量 LISTEN, 后续按 PID 过滤 */
async function rawListenLines(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      return await Process.lines(["netstat", "-ano"], { nothrow: true, timeout: 5000 })
    }
    return await Process.lines(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { nothrow: true, timeout: 5000 })
  } catch {
    return []
  }
}

/** BFS 收集 rootPid 的所有后代 (含自身). POSIX: pgrep -P; Windows: Get-CimInstance. */
async function collectDescendants(rootPid: number): Promise<Set<number>> {
  const out = new Set<number>([rootPid])
  if (rootPid <= 0) return out
  let frontier = [rootPid]
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const pid of frontier) {
      try {
        let lines: string[]
        if (process.platform === "win32") {
          lines = await Process.lines(
            ["powershell", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`],
            { nothrow: true, timeout: PROC_TREE_TIMEOUT },
          )
        } else {
          lines = await Process.lines(["pgrep", "-P", String(pid)], { nothrow: true, timeout: PROC_TREE_TIMEOUT })
        }
        for (const ln of lines) {
          const c = Number(ln.trim())
          if (Number.isInteger(c) && c > 0 && !out.has(c)) {
            out.add(c)
            next.push(c)
          }
        }
      } catch {
        /* 探测失败跳过, 不影响整体 */
      }
    }
    frontier = next
  }
  return out
}

/** 解析原始 LISTEN 行 → Map<port, PortEntry>, 仅保留 pid ∈ allowedPids 的端口 */
function parseListenForPids(
  lines: string[],
  selfPid: number,
  allowedPids: Set<number>,
): Map<number, PortEntry> {
  const seen = new Map<number, PortEntry>()
  for (const line of lines) {
    if (process.platform === "win32") {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (!m) continue
      const port = Number(m[1])
      const pid = Number(m[2])
      if (!valid(port) || pid === selfPid) continue
      if (!allowedPids.has(pid)) continue
      if (!seen.has(port)) seen.set(port, { port, pid, detectedAt: Date.now() })
      continue
    }
    // lsof: NAME 列形如 `*:8080 (LISTEN)` / `127.0.0.1:3000 (LISTEN)`
    if (!/\(LISTEN\)/i.test(line)) continue
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+\S+\s+\d+\w?\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+:(\d+)\s+\(LISTEN\)\s*$/i)
    if (!m) continue
    const port = Number(m[3])
    const pid = Number(m[2])
    if (!valid(port) || pid === selfPid) continue
    if (!allowedPids.has(pid)) continue
    if (!seen.has(port)) {
      seen.set(port, { port, pid, process: m[1], detectedAt: Date.now() })
    }
  }
  return seen
}

function valid(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** 检测 PID 是否存活 (POSIX: kill -0; Windows: tasklist). 失败/不存在返回 false. */
function isPidAlive(pid: number): Effect.Effect<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Effect.succeed(false)
  return Effect.tryPromise(async () => {
    try {
      if (process.platform === "win32") {
        const out = await Process.lines(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], { nothrow: true, timeout: 1500 })
        return out.some((l) => l.includes(String(pid)))
      }
      // POSIX: kill -0 不杀进程, 仅测试权限/存在; 退出码 0 = 存活
      const out = await Process.lines(["kill", "-0", String(pid)], { nothrow: true, timeout: 1500 })
      // kill -0 没输出但成功 (空数组 + 退出 0) 表示存活; 退出码 1 (权限/不存在) 时 Process.lines 返回 []
      // 通过 nothrow + timeout 已能区分; 此处用 Process.lines 的语义判断:
      //   kill -0 成功 → 进程存活
      // 我们直接探测 /proc/<pid> (linux) 或 ps -p (mac/linux), 兼容更广
      const psOut = await Process.lines(["ps", "-p", String(pid), "-o", "pid="], { nothrow: true, timeout: 1500 })
      return psOut.length > 0 && psOut.some((l) => l.trim().length > 0)
    } catch {
      return false
    }
  }).pipe(Effect.catch(() => Effect.succeed(false)))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const selfPid = process.pid
    /** 当前展示集: 进程树扫描 + 白名单 */
    const entries = yield* Ref.make(new Map<number, PortEntry>())
    const whitelist = yield* Ref.make(new Set<number>())
    /** numas 主动 spawn 的根 PID 集合 (PTY / Agent 工具). 每次 scan 时 BFS 求后代 */
    const trackedPids = yield* Ref.make(new Set<number>())
    /** 首次扫描前不推 detected (避免启动时把既有端口全当新增) */
    const firstScanDone = yield* Ref.make(false)

    const emit = (type: "ports.detected" | "ports.closed", properties: Record<string, unknown>) => {
      GlobalBus.emit("event", { directory: "global", payload: { type, properties } })
    }

const doScan = Effect.gen(function* () {
      const tracked = yield* Ref.get(trackedPids)
      // 清理已退出 PID (PTY/Agent 工具退出后, 主动回收避免永久保留)
      if (tracked.size > 0) {
        const survivors = new Set<number>()
        for (const pid of tracked) {
          if (yield* isPidAlive(pid)) survivors.add(pid)
        }
        if (survivors.size !== tracked.size) yield* Ref.set(trackedPids, survivors)
      }
      // 收集 numas 主动 spawn 的进程树 (含自身)
      const alive = yield* Ref.get(trackedPids)
      const allowedPids = new Set<number>()
      for (const pid of alive) {
        const desc = yield* Effect.tryPromise(() => collectDescendants(pid)).pipe(
          Effect.catch(() => Effect.succeed(new Set<number>([pid]))),
        )
        for (const p of desc) allowedPids.add(p)
      }
      // 扫宿主 LISTEN, 仅保留 pid ∈ allowedPids 的端口
      const raw = yield* Effect.tryPromise(() => rawListenLines()).pipe(Effect.catch(() => Effect.succeed([])))
      const scanned = parseListenForPids(raw, selfPid, allowedPids)
      // 合并白名单: 用户手动添加的端口直接入 next (即使未启动; pid 不确定)
      const wl = yield* Ref.get(whitelist)
      const next = new Map<number, PortEntry>(scanned)
      for (const p of wl) if (!next.has(p)) next.set(p, { port: p, detectedAt: Date.now() })

      const map = yield* Ref.get(entries)
      const isFirst = yield* Ref.get(firstScanDone)
      if (!isFirst) {
        yield* Ref.set(firstScanDone, true)
        yield* Ref.set(entries, next)
        return Array.from(next.values()).sort((a, b) => a.port - b.port)
      }

      for (const [port, e] of next) {
        if (!map.has(port)) emit("ports.detected", { port, pid: e.pid, process: e.process })
      }
      for (const [port, e] of map) {
        if (!next.has(port)) emit("ports.closed", { port, pid: e.pid })
      }
      yield* Ref.set(entries, next)
      return Array.from(next.values()).sort((a, b) => a.port - b.port)
    })

    // 全局单例, 后台周期扫描每 3s (进程生命周期内常驻; 不需要 scope 清理).
    // Effect layer 无 scope 可用 forkScoped → 用原生 setInterval 驱动.
    const timer = setInterval(() => {
      void Effect.runPromise(doScan).catch(() => {})
    }, 3000)
    // 启动立即扫一次 (供缓存预热, 不推事件)
    void Effect.runPromise(
      Effect.gen(function* () {
        yield* Ref.set(firstScanDone, false)
        yield* doScan
      }),
    ).catch(() => {})

    const service: Ports.Interface = {
      snapshot: () =>
        Ref.get(entries).pipe(Effect.map((m) => Array.from(m.values()).sort((a, b) => a.port - b.port))),
      scan: () => doScan,
      whitelist: (port) =>
        Effect.gen(function* () {
          if (!valid(port) || port < 1024) return
          const wl = yield* Ref.get(whitelist)
          if (wl.has(port)) return
          yield* Ref.set(whitelist, new Set([...wl, port]))
          const map = yield* Ref.get(entries)
          if (!map.has(port)) {
            yield* Ref.set(entries, new Map([...map, [port, { port, detectedAt: Date.now() }]]))
            emit("ports.detected", { port })
          }
        }),
      remove: (port) =>
        Effect.gen(function* () {
          const wl = yield* Ref.get(whitelist)
          if (wl.has(port)) yield* Ref.set(whitelist, new Set([...wl].filter((p) => p !== port)))
          const map = yield* Ref.get(entries)
          if (map.has(port)) return
          yield* Ref.set(entries, new Map([...map].filter(([p]) => p !== port)))
          emit("ports.closed", { port })
        }),
      isKnown: (port) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(entries)
          if (map.has(port)) return true
          const wl = yield* Ref.get(whitelist)
          return wl.has(port)
        }),
      registerPid: (pid) =>
        Effect.gen(function* () {
          if (!Number.isInteger(pid) || pid <= 0) return
          const cur = yield* Ref.get(trackedPids)
          if (cur.has(pid)) return
          yield* Ref.set(trackedPids, new Set([...cur, pid]))
          // 注册即扫一次 (覆盖已 LISTEN 的端口, 不用等下次定时)
          void Effect.runPromise(doScan).catch(() => {})
        }),
      unregisterPid: (pid) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(trackedPids)
          if (!cur.has(pid)) return
          yield* Ref.set(trackedPids, new Set([...cur].filter((p) => p !== pid)))
          // 反注册即扫一次 (该 PID 树关闭的端口立刻移除)
          void Effect.runPromise(doScan).catch(() => {})
        }),
      trackedPids: () => Ref.get(trackedPids).pipe(Effect.map((s) => Array.from(s).sort((a, b) => a - b))),
    }

    return service
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as PortsService from "./ports"
