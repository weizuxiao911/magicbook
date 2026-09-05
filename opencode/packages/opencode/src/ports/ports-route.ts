/**
 * Ports HTTP 路由 (numas fork 增量, raw router)
 *
 * 端点 (挂 authOnly, 与 ui/doc 同级; 请求路径在 handler 内手工 parse):
 *   GET    /ports              → 即时扫描 + 返回当前列表 [{port,pid?,process?,detectedAt}]
 *   POST   /ports  {port}      → 手动白名单 (供扫描不到的服务; 面板"添加端口")
 *   DELETE /ports/:port        → 从面板移除
 *   GET/POST/PUT/DELETE/PATCH  /proxy/:port/<rest>  → HTTP 反代到 127.0.0.1:<port>
 *   (Upgrade) /proxy/:port/<rest>                  → WS 反代 (vite HMR 等)
 *
 * 安全: /proxy 只允许转发到"已知端口" (Ports.Service.isKnown: 已发现或白名单),
 * 避免把 opencode 当开放代理 (SSRF). 目标固定 127.0.0.1.
 *
 * 注: 所有 Effect service (Ports/HttpClient) 都在 router 构建 gen 内闭包取得,
 * 不能放在顶层 Effect.fn — 组合后服务需求会丢失 (runtime Service not found).
 */

import { Service as PortsService, type Ports } from "./ports"
import { Effect, Layer } from "effect"
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpApiProxy } from "@/server/routes/instance/httpapi/middleware/proxy"

function proxyOnce(
  ports: Ports.Interface,
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost")
    const m = url.pathname.match(/^\/proxy\/(\d+)(?:\/(.*))?$/)
    if (!m) return HttpServerResponse.text("bad proxy path", { status: 400 })
    const port = Number(m[1])
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return HttpServerResponse.text("bad proxy port", { status: 400 })
    }
    const known = yield* ports.isKnown(port)
    if (!known) return HttpServerResponse.text(`port ${port} not known (scan or whitelist first)`, { status: 404 })

    // 目标: 127.0.0.1:<port> + 保留原始 path/query (去掉 /proxy/<port> 前缀)
    const target = new URL("http://127.0.0.1")
    target.port = String(port)
    target.pathname = m[2] ? `/${m[2]}` : "/"
    target.search = url.search

    const headers = request.headers as Record<string, string>
    if (headers["upgrade"]?.toLowerCase() === "websocket") {
      return yield* HttpApiProxy.websocket(request, target)
    }
    return yield* HttpApiProxy.http(client, target, undefined, request)
  })
}

export const portsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const ports = yield* PortsService
    const client = yield* HttpClient.HttpClient
    const proxy = (request: HttpServerRequest.HttpServerRequest) => proxyOnce(ports, client, request)

    yield* router.add("GET", "/ports", (request) =>
      Effect.gen(function* () {
        // 工作区目录来自 x-opencode-directory header (铁律 8; raw router 不经 WorkspaceRoutingMiddleware).
        // 传入后只返回监听进程 cwd 在该工作区下的端口 (+ 白名单); 缺失则返回用户项目服务全集.
        let workspace: string | undefined
        const rawHeader = (request.headers as Record<string, string | undefined>)["x-opencode-directory"]
        if (rawHeader) {
          try { workspace = decodeURIComponent(rawHeader) } catch { workspace = rawHeader }
        }
        const list = yield* ports.scan(workspace)
        return HttpServerResponse.jsonUnsafe(list)
      }),
    )
    yield* router.add("POST", "/ports", (request) =>
      Effect.gen(function* () {
        let body = ""
        try {
          body = yield* request.text
        } catch {
          return HttpServerResponse.jsonUnsafe({ error: "read body failed" }, { status: 400 })
        }
        let port = 0
        try {
          port = Number(JSON.parse(body).port)
        } catch {
          return HttpServerResponse.jsonUnsafe({ error: "invalid body" }, { status: 400 })
        }
        yield* ports.whitelist(port)
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    )
    yield* router.add("DELETE", "/ports/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const m = url.pathname.match(/^\/ports\/(\d+)$/)
        if (!m) return HttpServerResponse.jsonUnsafe({ error: "bad path" }, { status: 400 })
        yield* ports.remove(Number(m[1]))
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    )
    // /ports/pids {pid} : 注册 numas 主动 spawn 的根 PID (PTY create / Agent spawn 后调用)
    yield* router.add("POST", "/ports/pids", (request) =>
      Effect.gen(function* () {
        let body = ""
        try {
          body = yield* request.text
        } catch {
          return HttpServerResponse.jsonUnsafe({ error: "read body failed" }, { status: 400 })
        }
        let pid = 0
        try {
          pid = Number(JSON.parse(body).pid)
        } catch {
          return HttpServerResponse.jsonUnsafe({ error: "invalid body" }, { status: 400 })
        }
        if (!Number.isInteger(pid) || pid <= 0) {
          return HttpServerResponse.jsonUnsafe({ error: "bad pid" }, { status: 400 })
        }
        yield* ports.registerPid(pid)
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    )
    // /ports/pids/:pid : 反注册 (PTY onExit / Agent 工具退出时调用)
    yield* router.add("DELETE", "/ports/pids/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const m = url.pathname.match(/^\/ports\/pids\/(\d+)$/)
        if (!m) return HttpServerResponse.jsonUnsafe({ error: "bad path" }, { status: 400 })
        yield* ports.unregisterPid(Number(m[1]))
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    )
    // /proxy/<port>/<rest>: 任意方法反代
    yield* router.add("GET", "/proxy/*", proxy)
    yield* router.add("POST", "/proxy/*", proxy)
    yield* router.add("PUT", "/proxy/*", proxy)
    yield* router.add("DELETE", "/proxy/*", proxy)
    yield* router.add("PATCH", "/proxy/*", proxy)
  }),
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))

export * as PortsRoute from "./ports-route"
