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
import os from "node:os"
import path from "node:path"

export class PortEntry extends Schema.Class<PortEntry>("Ports.Entry")({
  port: Schema.Number,
  pid: Schema.Number.pipe(Schema.optional),
  process: Schema.String.pipe(Schema.optional),
  cwd: Schema.String.pipe(Schema.optional),
  detectedAt: Schema.Number,
}) {}

export class Service extends Context.Service<Service, Ports.Interface>()("@opencode/Ports") {}

export namespace Ports {
  export interface Interface {
    readonly snapshot: () => Effect.Effect<readonly PortEntry[]>
    readonly scan: (workspaceDir?: string) => Effect.Effect<readonly PortEntry[]>
    readonly whitelist: (port: number) => Effect.Effect<void>
    readonly remove: (port: number) => Effect.Effect<void>
    readonly isKnown: (port: number) => Effect.Effect<boolean>
    readonly registerPid: (pid: number) => Effect.Effect<void>
    readonly unregisterPid: (pid: number) => Effect.Effect<void>
    readonly trackedPids: () => Effect.Effect<readonly number[]>
    /** 关闭 (杀) 监听该端口的进程; 无监听者静默. 端口关闭由周期 scan diff 发 ports.closed. */
    readonly kill: (port: number) => Effect.Effect<void>
  }
}

/** 进程树递归最大深度, 防失控 */
const MAX_TREE_DEPTH = 16
/** 进程树单步探测超时 (ms) */
const PROC_TREE_TIMEOUT = 3000

/** 取原始监听行 (跨平台, 失败静默). 仍然扫全量 LISTEN, 后续按 cwd 归属过滤.
 *  POSIX 用 lsof -Fpcn 机器可读 (p=pid c=command n=name), 便于解析 pid/cmd/port 与批量取 cwd. */
async function rawListenLines(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      return await Process.lines(["netstat", "-ano"], { nothrow: true, timeout: 5000 })
    }
    return await Process.lines(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { nothrow: true, timeout: 5000 })
  } catch {
    return []
  }
}

/** 指定端口的监听 PID (kill 用, 只查该端口):
 *  POSIX: lsof -t -iTCP:<port> -sTCP:LISTEN (纯 pid 行); Windows: netstat -ano 解析 LISTENING. */
async function listenPidsForPort(port: number): Promise<number[]> {
  try {
    if (process.platform === "win32") {
      const lines = await Process.lines(["netstat", "-ano"], { nothrow: true, timeout: 5000 })
      const pids: number[] = []
      for (const line of lines) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
        if (m && Number(m[1]) === port) pids.push(Number(m[2]))
      }
      return [...new Set(pids)]
    }
    const out = await Process.lines(["lsof", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { nothrow: true, timeout: 3000 })
    return [...new Set(out.map((x) => Number(x.trim())).filter((p) => Number.isInteger(p) && p > 0))]
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

/** 解析原始 LISTEN 行 (lsof -Fpcn) → 原始端口候选 (port/pid/process), 不做归属过滤 */
function parseListenCandidates(lines: string[], selfPid: number): Array<{ port: number; pid: number; process?: string }> {
  const out: Array<{ port: number; pid: number; process?: string }> = []
  let pid = 0
  let cmd: string | undefined
  for (const line of lines) {
    const tag = line[0]
    const rest = line.slice(1)
    if (tag === "p") {
      pid = Number(rest)
      cmd = undefined
    } else if (tag === "c") {
      cmd = rest
    } else if (tag === "n") {
      const m = rest.match(/:(\d+)$/)
      if (!m) continue
      const port = Number(m[1])
      if (!valid(port) || !pid || pid === selfPid) continue
      if (!out.some((e) => e.port === port && e.pid === pid)) {
        out.push({ port, pid, process: cmd })
      }
    }
  }
  return out
}

/** 批量取 PID 的工作目录: mac lsof -d cwd; linux readlink /proc/<pid>/cwd; win 不支持 (TODO). */async function resolveCwds(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  const uniq = [...new Set(pids)].filter((p) => p > 0)
  if (uniq.length === 0) return map
  try {
    if (process.platform === "darwin") {
      const out = await Process.lines(["lsof", "-a", "-p", uniq.join(","), "-d", "cwd", "-Fn"], { nothrow: true, timeout: 5000 })
      let cur = 0
      for (const ln of out) {
        if (ln[0] === "p") cur = Number(ln.slice(1))
        else if (ln[0] === "n" && cur) map.set(cur, ln.slice(1))
      }
    } else if (process.platform === "linux") {
      const { readlink } = await import("node:fs/promises")
      await Promise.all(
        uniq.map(async (p) => {
          try {
            const cwd = await readlink(`/proc/${p}/cwd`)
            if (cwd) map.set(p, cwd)
          } catch { /* 无权限/已退出 */ }
        }),
      )
    }
  } catch { /* 探测失败静默, 走 tracked-tree 兜底 */ }
  return map
}

/** cwd 是否归属用户项目 (home 下, 但排除 ~/Library 沙盒应用数据).
 *  系统服务 cwd=/ 自然排除; Docker/WeChat 等 cwd 在 ~/Library/Containers 也排除. */
function isUserProjectCwd(cwd: string | undefined, home: string): boolean {
  if (!cwd) return false
  if (!isUnderWorkspace(cwd, home)) return false
  if (isUnderWorkspace(cwd, path.join(home, "Library"))) return false
  return true
}

/** cwd 是否在给定工作区目录下 (前缀归属). */
function isUnderWorkspace(cwd: string | undefined, workspace: string): boolean {
  if (!cwd || !workspace) return false
  const rel = path.relative(workspace, cwd)
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
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

    const home = os.homedir()

    /** Windows netstat -ano 解析 → {port,pid} (cwd 探测不支持, 仅靠 tracked-tree 兜底). */
    const parseNetstatCandidates = (lines: string[], selfPid: number) => {
      const out: Array<{ port: number; pid: number; process?: string }> = []
      for (const line of lines) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
        if (!m) continue
        const port = Number(m[1])
        const pid = Number(m[2])
        if (!valid(port) || !pid || pid === selfPid) continue
        if (!out.some((e) => e.port === port && e.pid === pid)) out.push({ port, pid })
      }
      return out
    }

    /** 计算"用户项目服务"全集: 监听进程 cwd 在 home 下 (主模型) ∪ tracked PTY/Agent 进程树 (兜底). */
    const computeUserServices = Effect.fnUntraced(function* () {
      const tracked = yield* Ref.get(trackedPids)
      const treePids = new Set<number>()
      for (const pid of tracked) {
        const desc = yield* Effect.tryPromise(() => collectDescendants(pid)).pipe(
          Effect.catch(() => Effect.succeed(new Set<number>([pid]))),
        )
        for (const p of desc) treePids.add(p)
      }
      const raw = yield* Effect.tryPromise(() => rawListenLines()).pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const cands = process.platform === "win32"
        ? parseNetstatCandidates(raw, selfPid)
        : parseListenCandidates(raw, selfPid)
      const cwdMap = yield* Effect.tryPromise(() => resolveCwds(cands.map((c) => c.pid))).pipe(
        Effect.catch(() => Effect.succeed(new Map<number, string>())),
      )
      const out = new Map<number, PortEntry>()
      for (const c of cands) {
        const cwd = cwdMap.get(c.pid)
        const fromCwd = isUserProjectCwd(cwd, home)
        const fromTree = treePids.has(c.pid)
        if (!fromCwd && !fromTree) continue
        if (out.has(c.port)) continue
        out.set(c.port, {
          port: c.port,
          pid: c.pid,
          process: c.process,
          ...(fromCwd && cwd ? { cwd } : {}),
          detectedAt: Date.now(),
        })
      }
      return out
    })

    /** 扫描. workspaceDir 给定时只返回 cwd 在该工作区下的端口 (+ 白名单); 不给返回用户项目服务全集.
     *  事件 diff 始终按"用户项目服务全集" (跨工作区, 一个服务启动只推一次). */
    const doScan = (workspaceDir?: string) =>
      Effect.gen(function* () {
        // 清理已退出 tracked 根进程 (PTY/Agent 退出后回收)
        const tracked = yield* Ref.get(trackedPids)
        if (tracked.size > 0) {
          const survivors = new Set<number>()
          const reaped: number[] = []
          for (const pid of tracked) {
            if (yield* isPidAlive(pid)) survivors.add(pid)
            else reaped.push(pid)
          }
          if (reaped.length > 0) {
            console.log(`[ports] scan: 根进程已退出, 回收 trackedPids=[${reaped.sort((a, b) => a - b).join(",")}]`)
            yield* Ref.set(trackedPids, survivors)
          }
        }

        const userAll = yield* computeUserServices()
        const wl = yield* Ref.get(whitelist)
        // 全集 (事件 diff + isKnown): 用户项目服务 + 白名单
        const globalNext = new Map<number, PortEntry>(userAll)
        for (const p of wl) if (!globalNext.has(p)) globalNext.set(p, { port: p, detectedAt: Date.now() })

        // 本工作区视图: cwd 在 workspace 下; 白名单始终包含; 无 workspace → 全集
        const inView = (e: PortEntry) =>
          !workspaceDir ? true : wl.has(e.port) || isUnderWorkspace(e.cwd, workspaceDir)
        const next = new Map<number, PortEntry>()
        for (const [port, e] of globalNext) if (inView(e)) next.set(port, e)

        const map = yield* Ref.get(entries)
        const isFirst = yield* Ref.get(firstScanDone)
        console.log(
          `[ports] scan: workspace=${workspaceDir ?? "(all)"} listenCands=${userAll.size} ` +
          `whitelist=[${[...wl].join(",")}] shown=[${[...next.keys()].sort((a, b) => a - b).join(",")}]` +
          `${isFirst ? "" : " (first)"}`,
        )
        if (!isFirst) {
          yield* Ref.set(firstScanDone, true)
          yield* Ref.set(entries, globalNext)
          return Array.from(next.values()).sort((a, b) => a.port - b.port)
        }

        for (const [port, e] of globalNext) {
          if (!map.has(port)) {
            console.log(`[ports] emit detected port=${port} pid=${e.pid ?? "-"} process=${e.process ?? "-"} cwd=${e.cwd ?? "-"}`)
            emit("ports.detected", { port, pid: e.pid, process: e.process, cwd: e.cwd })
          }
        }
        for (const [port, e] of map) {
          if (!globalNext.has(port)) {
            console.log(`[ports] emit closed port=${port} pid=${e.pid ?? "-"}`)
            emit("ports.closed", { port, pid: e.pid })
          }
        }
        yield* Ref.set(entries, globalNext)
        return Array.from(next.values()).sort((a, b) => a.port - b.port)
      })

    // 全局单例, 后台周期扫描每 3s (进程生命周期内常驻; 不需要 scope 清理).
    // Effect layer 无 scope 可用 forkScoped → 用原生 setInterval 驱动.
    const timer = setInterval(() => {
      void Effect.runPromise(doScan()).catch(() => {})
    }, 3000)
    // 启动立即扫一次 (供缓存预热, 不推事件)
    void Effect.runPromise(
      Effect.gen(function* () {
        yield* Ref.set(firstScanDone, false)
        yield* doScan()
      }),
    ).catch(() => {})

    const service: Ports.Interface = {
      snapshot: () =>
        Ref.get(entries).pipe(Effect.map((m) => Array.from(m.values()).sort((a, b) => a.port - b.port))),
      scan: (workspaceDir) => doScan(workspaceDir),
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
          const next = new Set([...cur, pid])
          yield* Ref.set(trackedPids, next)
          console.log(`[ports] registerPid pid=${pid} trackedRoots=[${[...next].sort((a, b) => a - b).join(",")}]`)
          // 注册即扫一次 (覆盖已 LISTEN 的端口, 不用等下次定时)
          void Effect.runPromise(doScan()).catch(() => {})
        }),
      unregisterPid: (pid) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(trackedPids)
          if (!cur.has(pid)) return
          const next = new Set([...cur].filter((p) => p !== pid))
          yield* Ref.set(trackedPids, next)
          console.log(`[ports] unregisterPid pid=${pid} trackedRoots=[${[...next].sort((a, b) => a - b).join(",")}]`)
          // 反注册即扫一次 (该 PID 树关闭的端口立刻移除)
          void Effect.runPromise(doScan()).catch(() => {})
        }),
      trackedPids: () => Ref.get(trackedPids).pipe(Effect.map((s) => Array.from(s).sort((a, b) => a - b))),
      kill: (port) =>
        Effect.gen(function* () {
          const pids = yield* Effect.promise(() => listenPidsForPort(port))
          if (pids.length === 0) {
            console.log(`[ports] kill port=${port}: 无监听进程`)
            return
          }
          const cmd = process.platform === "win32" ? "taskkill" : "kill"
          const args = process.platform === "win32" ? ["/T", ...pids.flatMap((p) => ["/PID", String(p)])] : pids.map(String)
          yield* Effect.promise(() =>
            Process.lines([cmd, ...args], { nothrow: true, timeout: 5000 }).then(() => undefined),
          )
          console.log(`[ports] kill port=${port} pids=[${pids.join(",")}]`)
          // 杀完立即扫一次: ports.closed diff 立刻发出 (不等 3s 周期)
          yield* doScan()
        }),
    }

    return service
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as PortsService from "./ports"
