import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { resolve as pathResolve } from "node:path"
import { ProxyUtil } from "../proxy-util"

/** Registry 地址 (--registry): sumi 扩展市场服务, 注入到嵌入的 web UI */
export const RegistryConfig = Context.Reference<string | undefined>("@opencode/RegistryConfig", {
  defaultValue: () => undefined,
})

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  // numas: 内嵌的是 opensumi (codeblitz) IDE, local dev tool — 全面放开 CSP
  //   - default-src * (允许所有协议/host)
  //   - script/worker/style/img/font/connect/frame/manifest 全 *
  //   - 不限制 unsafe-inline / unsafe-eval / wasm-unsafe-eval
  `default-src *; script-src * 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src * data: blob:; worker-src * blob:; frame-src *; manifest-src *; object-src *; base-uri *; form-action *`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array, registry?: string) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  let data = body
  if (mime.startsWith("text/html")) {
    const html = new TextDecoder().decode(body)
    headers.set("content-security-policy", cspForHtml(html))
    // 注入 registry 地址: sumi 前端读 window.__APP_CONFIG__.registryBaseUrl (运行时优先)
    if (registry) {
      const script = `<script>window.__APP_CONFIG__ = Object.assign({}, window.__APP_CONFIG__, { registryBaseUrl: ${JSON.stringify(registry)} });</script>`
      data = new TextEncoder().encode(html.replace("</body>", script + "</body>"))
    }
  }
  return HttpServerResponse.raw(data, { headers })
}

/** 从磁盘 UI 目录读一个文件 (--web-ui 模式), 防目录穿越; 不存在 → undefined.
 *  未知路径 (SPA 路由) 回退 index.html — 与 embedded 兜底行为一致. */
function serveDiskUI(
  requestPath: string,
  fs: FSUtil.Interface,
  webRoot: string,
  registry?: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined, never, never> {
  const rootReal = FSUtil.resolve(webRoot)
  const rel = decodeURIComponent(requestPath.replace(/^\//, "")).replaceAll("\\", "/")
  const readIfInside = (
    name: string,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined, never, never> => {
    const abs = pathResolve(rootReal, name)
    if (!FSUtil.contains(rootReal, abs)) return Effect.succeed(undefined)
    return fs.readFile(abs).pipe(
      Effect.map((content) => embeddedUIResponse(abs, content, registry)),
      Effect.catch(() => Effect.succeed(undefined as HttpServerResponse.HttpServerResponse | undefined)),
    )
  }
  if (rel && !rel.endsWith("/")) {
    return readIfInside(rel).pipe(
      Effect.flatMap((hit) => (hit ? Effect.succeed(hit) : readIfInside("index.html"))),
    )
  }
  return readIfInside("index.html")
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
  registry?: string,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body, registry)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: {
    fs: FSUtil.Interface
    client: HttpClient.HttpClient
    disableEmbeddedWebUi: boolean
    /** 磁盘 UI 目录 (--web-ui): 运行时用磁盘上的 web UI 静态产物替换内嵌 bundle.
     *  dev 场景: sumi 改完只需重建产物 + 重启 server, 不必重编 opencode 二进制. */
    webUIRoot?: string
  },
) {
  return Effect.gen(function* () {
    const registry = yield* RegistryConfig
    const path = new URL(request.url, "http://localhost").pathname

    // --web-ui 磁盘目录优先: 每次请求实时读盘
    if (services.webUIRoot) {
      const disk = yield* serveDiskUI(path, services.fs, services.webUIRoot, registry)
      if (disk) return disk
    }

    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, registry)

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
