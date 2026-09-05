// opencode 内置扩展市场控制器 (/extensions) — 替代独立 registry 服务
//
// 背景: 独立 registry (node 服务 :7790) 需第二进程 + opencode /proxy 端口反代
// (依赖端口 scan/lsof, 容器缺 lsof 即全挂; scan 3s 窗口有竞态). 本控制器把
// "扫描 .vsix → metadata + 静态分发" 能力移入 opencode 同进程, 同源直出:
//   GET /extensions/metadata.json       → IExtensionBasicMetadata[] (动态扫描)
//   GET /extensions/<id>/manifest.json  → 文件清单 (codeblitz 安装管线)
//   GET /extensions/<id>/<file>         → vsix 内 extension/ 平铺资源
//
// vsix 目录: --extensions-dir (容器 /root/.numas/extensions, dev registry/vsix).
// 目录契约与工程 registry/vsix 同构; 每次请求校验目录签名 (mtime/size),
// 新增 .vsix 自动入 metadata (动态添加), 无需重启.
// metadata uri 不带 authority (kt-ext:///<id>), 前端分流到 registryBaseUrl.

import { Effect } from "effect"
import AdmZip from "adm-zip"
import fs from "node:fs"
import path from "node:path"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const PICK_FIELDS = [
  "name",
  "publisher",
  "version",
  "repository",
  "displayName",
  "description",
  "icon",
  "activationEvents",
  "sumiContributes",
  "contributes",
  "browser",
  "main",
] as const

type Meta = Record<string, unknown>

function pick(pkg: Record<string, unknown>): Meta {
  const out: Meta = {}
  for (const k of PICK_FIELDS) if (pkg[k] !== undefined) out[k] = pkg[k]
  return out
}

function mergeContributes(pkg: Record<string, unknown>): Record<string, unknown> {
  const sumi = (pkg.sumiContributes ?? {}) as Record<string, unknown>
  const cur = (pkg.contributes ?? {}) as Record<string, unknown>
  const out = { ...cur }
  for (const [k, v] of Object.entries(sumi)) {
    if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...(out[k] as unknown[]), ...v]
    else if (out[k] === undefined) out[k] = v
  }
  return out
}

interface Index {
  ensure(): void
  metas(): Meta[]
  has(id: string): boolean
  /** vsix 内 extension/ 下的相对文件清单 */
  manifest(id: string): string[] | undefined
  /** 读取 extension/<rel> 文件内容; 无则 undefined */
  read(id: string, rel: string): Buffer | undefined
}

function createIndex(vsixDir: string): Index {
  let sig = ""
  let metas: Meta[] = []
  const zips = new Map<string, AdmZip>()

  const calcSig = () => {
    if (!fs.existsSync(vsixDir)) return ""
    let s = ""
    for (const f of fs.readdirSync(vsixDir)) {
      if (!f.endsWith(".vsix")) continue
      try {
        const st = fs.statSync(path.join(vsixDir, f))
        s += `${f}|${st.mtimeMs}|${st.size};`
      } catch {
        // 文件竞争删除, 忽略
      }
    }
    return s
  }

  const rebuild = () => {
    metas = []
    zips.clear()
    if (!fs.existsSync(vsixDir)) return
    for (const file of fs.readdirSync(vsixDir)) {
      if (!file.endsWith(".vsix")) continue
      try {
        const zip = new AdmZip(path.join(vsixDir, file))
        const pkgEntry = zip.getEntry("extension/package.json")
        if (!pkgEntry) {
          console.warn(`[extensions] skip ${file}: no extension/package.json`)
          continue
        }
        const pkg = JSON.parse(pkgEntry.getData().toString("utf-8")) as Record<string, unknown>
        if (!pkg.name || !pkg.publisher || !pkg.version) {
          console.warn(`[extensions] skip ${file}: missing name/publisher/version`)
          continue
        }
        const id = `${pkg.publisher}.${pkg.name}-${pkg.version}`
        const picked = pick(pkg)
        picked.contributes = mergeContributes(pkg)
        // 不带 authority 的 kt-ext uri: 前端分流到 registryBaseUrl (同源 /extensions 或外部)
        metas.push({
          extension: { publisher: pkg.publisher, name: pkg.name, version: pkg.version },
          packageJSON: picked,
          defaultPkgNlsJSON: {},
          pkgNlsJSON: {},
          nlsList: [],
          extendConfig: {},
          webAssets: [],
          mode: "local",
          uri: `kt-ext:///${id}`,
        })
        zips.set(id, zip)
        console.log(`[extensions] loaded ${id} <- ${file}`)
      } catch (e) {
        console.warn(`[extensions] skip ${file}:`, e instanceof Error ? e.message : String(e))
      }
    }
  }

  return {
    ensure: () => {
      const next = calcSig()
      if (next !== sig) {
        sig = next
        rebuild()
      }
    },
    metas: () => metas,
    has: (id) => zips.has(id),
    manifest: (id) => {
      const zip = zips.get(id)
      if (!zip) return undefined
      const files: string[] = []
      for (const e of zip.getEntries()) {
        if (!e.entryName.startsWith("extension/")) continue
        const rel = e.entryName.slice("extension/".length)
        if (rel && !e.isDirectory) files.push(rel)
      }
      return files
    },
    read: (id, rel) => {
      const zip = zips.get(id)
      if (!zip) return undefined
      const entry = zip.getEntry(`extension/${rel}`)
      if (!entry || entry.isDirectory) return undefined
      return entry.getData()
    },
  }
}

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".wasm": "application/wasm",
}

function json(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { headers: { "Cache-Control": "no-cache" } })
}

function notFound() {
  return HttpServerResponse.text("Not Found", { status: 404 })
}

/** /extensions 控制器路由 (vsixDir 为空时注册空索引: metadata=[] 优雅降级). */
export function extensionsRoute(vsixDir?: string) {
  const index = createIndex(vsixDir ?? "")
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      const handle = Effect.fn("ExtensionsHttp.handle")(function* (request: HttpServerRequest.HttpServerRequest) {
        index.ensure()
        const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
        if (urlPath === "/extensions/metadata.json") {
          return json(index.metas())
        }
        const m = urlPath.match(/^\/extensions\/([^/]+)\/(.+)$/)
        if (!m) return notFound()
        const [, id, rest] = m
        if (!index.has(id)) return notFound()
        if (rest === "manifest.json") {
          const files = index.manifest(id)
          return files ? json(files) : notFound()
        }
        const data = index.read(id, rest)
        if (!data) return notFound()
        const ext = path.extname(rest).toLowerCase()
        return HttpServerResponse.raw(new Uint8Array(data), {
          headers: {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Cache-Control": "no-cache",
          },
        })
      })
      yield* router.add("GET", "/extensions/*", handle)
    }),
  )
}
