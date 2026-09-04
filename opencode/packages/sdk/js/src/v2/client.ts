export * from "./gen/types.gen.js"
export type { FileSystemEntry as LocationFileSystemEntry } from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  // numas fork: 严格遵循铁律 8 — header 是 workspace 唯一真实路径 (raw, 不 encode).
  // 不写 query: V1 端点 (/pty /file /path) server 中间件不读 query,
  //   写进去反而让 server defaultDirectory 走 fallback process.cwd() → 切工作目录失效 + WS 404.
  // header 已由 createOpencodeClient config.headers 注入; interceptor 仅校验缺失并显式 warn.
  if (!values.directory && !request.headers.has("x-opencode-directory")) {
    console.warn("[opencode-sdk] x-opencode-directory header missing; server will fallback to process.cwd()")
  }
  if (!values.workspace && !request.headers.has("x-opencode-workspace")) {
    console.warn("[opencode-sdk] x-opencode-workspace header missing")
  }
  return request
}

export function createOpencodeClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  // numas fork: header 走 encodeURI 形态 (铁律 8 + 兼容 fetch ISO-8859-1).
  //   raw path 含中文等非 ASCII 字符会 throw "String contains non ISO-8859-1 code point".
  //   server defaultDirectory 防御性 decodeURIComponent, 含非 ASCII 路径两端兼容.
  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURI(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-opencode-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
