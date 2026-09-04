import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { RelativePath } from "@opencode-ai/core/schema"
import path from "path"
import { Cause, Effect, Queue, Ref, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { WatchEvent } from "@opencode-ai/protocol/groups/fs"
import { FileNotFoundError } from "@opencode-ai/protocol/errors"
import { PlatformError } from "effect/PlatformError"
import { Api } from "../api"
import { response } from "../location"

const DEBOUNCE_MS = 200
const TICK_MS = 100

/** Map filesystem NotFound (surfaced as a die via `Effect.orDie` in core) to a typed 404. */
const fileSystem = <A, R>(self: Effect.Effect<A, never, R>) =>
  self.pipe(
    Effect.catchCause((cause) => {
      const die = cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      if (error instanceof PlatformError && error.reason._tag === "NotFound") {
        const p = typeof error.reason.pathOrDescriptor === "string" ? error.reason.pathOrDescriptor : ""
        return Effect.fail(new FileNotFoundError({ path: p, message: error.message }))
      }
      return Effect.failCause(cause)
    }),
  )

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const file = yield* (yield* FileSystem.Service).read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }).pipe(fileSystem),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }).pipe(fileSystem),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handle("fs.stat", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.stat({ path: ctx.query.path })
          }).pipe(fileSystem),
        ),
      )
      .handle("fs.write", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const { path, content, mode } = ctx.payload
          const bytes = new Uint8Array(Buffer.from(content, "base64"))
          yield* fs.write({ path, content: bytes, mode })
        }).pipe(fileSystem),
      )
      .handle("fs.mkdir", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          yield* fs.mkdir(ctx.payload)
        }),
      )
      .handle("fs.remove", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          yield* fs.remove(ctx.payload)
        }).pipe(fileSystem),
      )
      .handle("fs.rename", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          yield* fs.rename(ctx.payload)
        }).pipe(fileSystem),
      )
      .handleRaw("fs.watch", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const location = yield* Location.Service
          const rootReal = yield* fs.realPath(location.directory).pipe(Effect.orElseSucceed(() => location.directory))
          const subpath = ctx.query.path
          const watchRoot = subpath ? path.resolve(location.directory, FSUtil.windowsPath(subpath)) : location.directory
          const filterRootReal = subpath
            ? yield* fs.realPath(watchRoot).pipe(Effect.orElseSucceed(() => watchRoot))
            : rootReal

          const out = yield* Queue.unbounded<{
            readonly path: string
            readonly type: "add" | "change" | "unlink"
            readonly timestamp: number
          }>()
          const buffer = yield* Ref.make(new Map<string, { path: string; type: "add" | "change" | "unlink" }>())
          const lastUpdate = yield* Ref.make(0)

          const subscription = yield* Watcher.subscribe(
            watchRoot,
            (_err, updates) => {
              const now = Date.now()
              for (const u of updates) {
                const t: "add" | "change" | "unlink" =
                  u.type === "create" ? "add" : u.type === "delete" ? "unlink" : "change"
                const rel = path.relative(filterRootReal, u.path)
                if (rel.startsWith("..") || path.isAbsolute(rel)) continue
                Effect.runSync(
                  Effect.gen(function* () {
                    yield* Ref.update(buffer, (m) => {
                      const next = new Map(m)
                      next.set(u.path, { path: rel, type: t })
                      return next
                    })
                    yield* Ref.set(lastUpdate, now)
                  }),
                )
              }
            },
            { ignore: [".git", "node_modules"] },
          )
          if (subscription) {
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => subscription.unsubscribe()).pipe(Effect.ignore),
            )
          }

          const flusher = Stream.tick(`${TICK_MS} millis`).pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                const last = yield* Ref.get(lastUpdate)
                if (last === 0) return
                if (Date.now() - last < DEBOUNCE_MS) return
                const drained = yield* Ref.getAndSet(buffer, new Map())
                yield* Ref.set(lastUpdate, 0)
                if (drained.size === 0) return
                const ts = Date.now()
                for (const ev of drained.values()) {
                  yield* Queue.offer(out, { ...ev, timestamp: ts })
                }
              }),
            ),
          )
          yield* Effect.forkScoped(flusher)

          const sseStream = Stream.fromQueue(out).pipe(
            Stream.map((ev) => ({
              _tag: "Event" as const,
              event: "message",
              id: undefined,
              data: JSON.stringify(ev),
            })),
            Stream.pipeThroughChannel(Sse.encode()),
          )
          const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
          return HttpServerResponse.stream(
            sseStream.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
            {
              contentType: "text/event-stream; charset=utf-8",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
  }),
)
