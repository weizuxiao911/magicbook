/**
 * PortsService — 本地服务端口发现 (numas fork 增量, 全局单例)
 *
 * 对标 VSCode 端口面板:
 *   - 周期扫描宿主机 LISTEN 端口 (mac/linux lsof, win netstat)
 *   - 基线 diff → 新增推 `ports.detected`, 消失推 `ports.closed`
 *     (走 GlobalBus → /global/event SSE → codeblitz 提示)
 *   - GET /ports 快照 / POST /ports 手动白名单 / DELETE /ports/:port 移除
 *   - /proxy/:port/* 仅代理"已知端口" (防 SSRF: 不把 opencode 当开放代理)
 *
 * 排除:
 *   - 本进程监听的端口 (opencode 自身, pid === process.pid)
 *   - dev 辅助端口 (registry 7790 / webpack 7788, 独立进程扫得到但不应展示)
 *   - 1024 以下特权端口默认不自动提示
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
  }
}

/** dev 辅助进程固定端口 (registry/webpack devServer), 不展示 */
const ALWAYS_EXCLUDE = new Set([7790, 7788])

/** 明确非开发的 GUI/系统/代理进程, 不展示 (对标 VSCode: 不转发无关系统服务) */
const IGNORE_PROCESS = /^(launchd|systemd|rapportd|ControlCe|WeChat|DingTalk|clash-ver|Trae|ApifoxApp|com\.docke|CoreSimulator|mDNSResponder|configd|airportd|WiFiAgent|apsd|bird|nsurlsessiond|secinit|uedit|locationd|symptomsd|loginwindow|WindowServer|Safari|Google Chrome|Firefox|QQMusic|NetEaseMusic|Telegram|Slack|Discord|Zoom\.us|Microsoft Teams)$/i

/** 取原始监听行 (跨平台, 失败静默) */
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

/** 解析原始行 → 端口条目 (win: netstat 无进程名; posix: lsof) */
function parseLines(lines: string[], selfPid: number): PortEntry[] {
  const seen = new Map<number, PortEntry>()
  for (const line of lines) {
    if (process.platform === "win32") {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (!m) continue
      const port = Number(m[1])
      const pid = Number(m[2])
      if (!valid(port) || pid === selfPid || ALWAYS_EXCLUDE.has(port)) continue
      if (!seen.has(port)) seen.set(port, { port, pid: pid || undefined, detectedAt: Date.now() })
      continue
    }
    // lsof: NAME 列形如 `*:8080 (LISTEN)` / `127.0.0.1:3000 (LISTEN)`
    if (!/\(LISTEN\)/i.test(line)) continue
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+\S+\s+\d+\w?\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+:(\d+)\s+\(LISTEN\)\s*$/i)
    if (!m) continue
    const port = Number(m[3])
    const pid = Number(m[2])
    if (!valid(port) || pid === selfPid || ALWAYS_EXCLUDE.has(port)) continue
    if (!seen.has(port)) {
      seen.set(port, { port, pid, process: m[1], detectedAt: Date.now() })
    }
  }
  return Array.from(seen.values())
}

function valid(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const selfPid = process.pid
    /** 当前展示集: 发现 + 白名单 */
    const entries = yield* Ref.make(new Map<number, PortEntry>())
    const whitelist = yield* Ref.make(new Set<number>())
    /** 首次扫描前不推 detected (避免启动时把既有端口全当新增) */
    const firstScanDone = yield* Ref.make(false)

    const emit = (type: "ports.detected" | "ports.closed", properties: Record<string, unknown>) => {
      GlobalBus.emit("event", { directory: "global", payload: { type, properties } })
    }

    const doScan = Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() => rawListenLines()).pipe(Effect.catch(() => Effect.succeed([])))
      const found = parseLines(raw, selfPid)
        .filter((e) => e.port >= 1024)
        .filter((e) => !(e.process && IGNORE_PROCESS.test(e.process)))
      const map = yield* Ref.get(entries)
      const wl = yield* Ref.get(whitelist)
      const next = new Map<number, PortEntry>()
      for (const e of found) next.set(e.port, e)
      for (const p of wl) if (!next.has(p)) next.set(p, { port: p, detectedAt: Date.now() })

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
        if (!next.has(port) && !wl.has(port)) emit("ports.closed", { port, pid: e.pid })
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
          if (!valid(port) || port < 1024 || ALWAYS_EXCLUDE.has(port)) return
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
          if (!map.has(port)) return
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
    }

    return service
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as PortsService from "./ports"
