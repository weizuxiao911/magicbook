export * as FileSystem from "./filesystem"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { optional, PositiveInt, RelativePath } from "./schema"
import { FileSystemSearch } from "./filesystem/search"
import { Entry, FileSystem, FindInput, Match } from "@opencode-ai/schema/filesystem"
import { EventV2 } from "./event"
import { Watcher } from "./filesystem/watcher"
export { Entry, Match, Submatch } from "@opencode-ai/schema/filesystem"

export const ReadInput = Schema.Struct({
  path: RelativePath,
})
export type ReadInput = typeof ReadInput.Type

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export const ListInput = Schema.Struct({
  path: RelativePath.pipe(optional),
})
export type ListInput = typeof ListInput.Type

export { FindInput }

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: RelativePath.pipe(optional),
  limit: PositiveInt.pipe(optional),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: RelativePath.pipe(optional),
  include: Schema.String.pipe(optional),
  limit: PositiveInt.pipe(optional),
}) {}

export const StatInput = Schema.Struct({
  path: RelativePath,
})
export type StatInput = typeof StatInput.Type

export const WriteInput = Schema.Struct({
  path: RelativePath,
  content: Schema.Uint8Array,
  mode: Schema.Int.pipe(optional),
})
export type WriteInput = typeof WriteInput.Type

export const MkdirInput = Schema.Struct({
  path: RelativePath,
  recursive: Schema.Boolean.pipe(optional),
})
export type MkdirInput = typeof MkdirInput.Type

export const RemoveInput = Schema.Struct({
  path: RelativePath,
  recursive: Schema.Boolean.pipe(optional),
})
export type RemoveInput = typeof RemoveInput.Type

export const RenameInput = Schema.Struct({
  from: RelativePath,
  to: RelativePath,
})
export type RenameInput = typeof RenameInput.Type

export const Event = FileSystem.Event

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<{ readonly content: Uint8Array; readonly mime: string }>
  readonly list: (input?: ListInput) => Effect.Effect<Entry[]>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[]>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[]>
  readonly stat: (input: StatInput) => Effect.Effect<Entry>
  readonly write: (input: WriteInput) => Effect.Effect<void>
  readonly mkdir: (input: MkdirInput) => Effect.Effect<void>
  readonly remove: (input: RemoveInput) => Effect.Effect<void>
  readonly rename: (input: RenameInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const search = yield* FileSystemSearch.Service
    const events = yield* EventV2.Service
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const resolve = Effect.fnUntraced(function* (input?: RelativePath) {
      const absolute = path.resolve(location.directory, input ?? ".")
      if (!FSUtil.contains(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      const real = yield* fs.realPath(absolute).pipe(Effect.orDie)
      if (!FSUtil.contains(root, real)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, real, directory: location.directory, root }
    })
    const resolveTarget = Effect.fnUntraced(function* (input: RelativePath) {
      const absolute = path.resolve(location.directory, input)
      if (!FSUtil.contains(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      let parent = path.dirname(absolute)
      while (!(yield* fs.exists(parent).pipe(Effect.orDie))) {
        const next = path.dirname(parent)
        if (next === parent) return yield* Effect.die(new Error("Path escapes the location"))
        parent = next
      }
      const parentReal = yield* fs.realPath(parent).pipe(Effect.orDie)
      if (!FSUtil.contains(root, parentReal)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, directory: location.directory, root }
    })
    const toEntry = (
      absolute: string,
      directory: string,
      type: "file" | "directory",
      info?: { size?: number; mtime?: number },
    ): Entry => {
      const relative = path.relative(directory, absolute)
      return Entry.make({
        path: RelativePath.make(relative + (type === "directory" ? path.sep : "")),
        type,
        ...(info?.size !== undefined ? { size: info.size } : {}),
        ...(info?.mtime !== undefined ? { mtime: info.mtime } : {}),
      })
    }
    return Service.of({
      find: search.find,
      glob: search.glob,
      grep: search.grep,
      read: Effect.fn("FileSystem.read")(function* (input) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "File") return yield* Effect.die(new Error("Path is not a file"))
        return {
          content: yield* fs.readFile(target.real).pipe(Effect.orDie),
          mime: FSUtil.mimeType(target.real),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "Directory") return yield* Effect.die(new Error("Path is not a directory"))
        return yield* fs.readDirectoryEntries(target.real).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.join(target.absolute, item.name)
                return [toEntry(absolute, target.directory, item.type)]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
      stat: Effect.fn("FileSystem.stat")(function* (input) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "File" && info.type !== "Directory")
          return yield* Effect.die(new Error("Path is not a regular file or directory"))
        const isDir = info.type === "Directory"
        const fileInfo = isDir
          ? undefined
          : {
              size: Number(info.size),
              mtime: Option.match(info.mtime, {
                onNone: () => undefined,
                onSome: (date) => date.getTime(),
              }),
            }
        return toEntry(target.absolute, target.directory, isDir ? "directory" : "file", fileInfo)
      }),
      write: Effect.fn("FileSystem.write")(function* (input) {
        const target = yield* resolveTarget(input.path)
        const exists = yield* fs.existsSafe(target.absolute)
        if (input.mode !== undefined) {
          yield* fs.writeFile(target.absolute, input.content, { mode: input.mode }).pipe(Effect.orDie)
        } else {
          yield* fs.writeFile(target.absolute, input.content).pipe(Effect.orDie)
        }
        yield* events.publish(FileSystem.Event.Edited, { file: target.absolute })
        yield* events.publish(Watcher.Event.Updated, {
          file: target.absolute,
          event: exists ? "change" : "add",
        })
      }),
      mkdir: Effect.fn("FileSystem.mkdir")(function* (input) {
        const target = yield* resolveTarget(input.path)
        yield* fs.makeDirectory(target.absolute, { recursive: input.recursive ?? true }).pipe(Effect.orDie)
        yield* events.publish(Watcher.Event.Updated, { file: target.absolute, event: "add" })
      }),
      remove: Effect.fn("FileSystem.remove")(function* (input) {
        const target = yield* resolve(input.path)
        yield* fs.remove(target.absolute, { recursive: input.recursive ?? false }).pipe(Effect.orDie)
        yield* events.publish(FileSystem.Event.Removed, { file: target.absolute })
        yield* events.publish(Watcher.Event.Updated, { file: target.absolute, event: "unlink" })
      }),
      rename: Effect.fn("FileSystem.rename")(function* (input) {
        const from = yield* resolve(input.from)
        const to = yield* resolveTarget(input.to)
        yield* fs.rename(from.absolute, to.absolute).pipe(Effect.orDie)
        yield* events.publish(FileSystem.Event.Renamed, { from: from.absolute, to: to.absolute })
        yield* events.publish(Watcher.Event.Updated, { file: from.absolute, event: "unlink" })
        yield* events.publish(Watcher.Event.Updated, { file: to.absolute, event: "add" })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node, EventV2.node],
})
