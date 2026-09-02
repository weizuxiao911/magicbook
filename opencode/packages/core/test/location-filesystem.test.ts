import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystem.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

const pathExists = (filepath: string) =>
  Effect.promise(() =>
    fs
      .access(filepath)
      .then(() => true)
      .catch(() => false),
  )

describe("FileSystem", () => {
  it.live("reads text and binary files", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "text.txt"), "hello"))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "data.bin"), Buffer.from([0, 1, 2])))
        const service = yield* FileSystem.Service
        const text = yield* service.read({ path: RelativePath.make("text.txt") })
        const binary = yield* service.read({ path: RelativePath.make("data.bin") })
        expect(new TextDecoder().decode(text.content)).toBe("hello")
        expect(text.mime).toBe("text/plain")
        expect(binary.content).toEqual(new Uint8Array([0, 1, 2]))
      }).pipe(provide(directory)),
    ),
  )

  it.live("lists direct children", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "README.md"), "# Test"))
        const entries = yield* (yield* FileSystem.Service).list()
        expect(entries.map((entry) => ({ path: entry.path, type: entry.type }))).toEqual([
          { path: RelativePath.make("src" + path.sep), type: "directory" },
          { path: RelativePath.make("README.md"), type: "file" },
        ])
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects lexical escapes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* (yield* FileSystem.Service)
          .read({ path: RelativePath.make("../outside.txt") })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  it.live("stat returns entry for files and directories", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "sub")))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "file.txt"), "x"))
        const service = yield* FileSystem.Service
        const file = yield* service.stat({ path: RelativePath.make("file.txt") })
        const dir = yield* service.stat({ path: RelativePath.make("sub") })
        expect({ path: file.path, type: file.type }).toEqual({ path: RelativePath.make("file.txt"), type: "file" })
        expect({ path: dir.path, type: dir.type }).toEqual({ path: RelativePath.make("sub" + path.sep), type: "directory" })
      }).pipe(provide(directory)),
    ),
  )

  it.live("write creates and overwrites files", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* service.write({ path: RelativePath.make("a.txt"), content: new Uint8Array([104, 105]) })
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("hi")
        yield* service.write({ path: RelativePath.make("a.txt"), content: new Uint8Array([98, 121, 101]) })
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "a.txt"), "utf8"))).toBe("bye")
      }).pipe(provide(directory)),
    ),
  )

  it.live("mkdir creates nested directories", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* (yield* FileSystem.Service).mkdir({
          path: RelativePath.make("a/b/c"),
          recursive: true,
        })
        const stat = yield* Effect.promise(() => fs.stat(path.join(directory, "a", "b", "c")))
        expect(stat.isDirectory()).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  it.live("remove deletes files and directories", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "x.txt"), "x"))
        yield* service.remove({ path: RelativePath.make("x.txt") })
        expect(yield* pathExists(path.join(directory, "x.txt"))).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("rename moves files within the location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "nested")))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "old.txt"), "x"))
        yield* service.rename({
          from: RelativePath.make("old.txt"),
          to: RelativePath.make("nested/new.txt"),
        })
        expect(yield* pathExists(path.join(directory, "old.txt"))).toBe(false)
        const stat = yield* Effect.promise(() => fs.stat(path.join(directory, "nested", "new.txt")))
        expect(stat.isFile()).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  it.live("write rejects paths that escape the location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* (yield* FileSystem.Service)
          .write({ path: RelativePath.make("../escape.txt"), content: new Uint8Array([0x78]) })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* pathExists(path.join(directory, "..", "escape.txt"))).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("remove rejects paths that escape the location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* (yield* FileSystem.Service)
          .remove({ path: RelativePath.make("../victim.txt") })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  it.live("rename rejects targets that escape the location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "stays.txt"), "x"))
        const result = yield* (yield* FileSystem.Service)
          .rename({
            from: RelativePath.make("stays.txt"),
            to: RelativePath.make("../escapes.txt"),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* pathExists(path.join(directory, "stays.txt"))).toBe(true)
      }).pipe(provide(directory)),
    ),
  )
})
