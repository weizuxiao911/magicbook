import { FileSystem } from "@opencode-ai/schema/filesystem"
import { Location } from "@opencode-ai/schema/location"
import { PositiveInt, RelativePath } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

const StatQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath,
})

const WritePayload = Schema.Struct({
  path: RelativePath,
  content: Schema.String,
  mode: Schema.Number.pipe(Schema.optional),
})

const MkdirPayload = Schema.Struct({
  path: RelativePath,
  recursive: Schema.Boolean.pipe(Schema.optional),
})

const RemovePayload = Schema.Struct({
  path: RelativePath,
  recursive: Schema.Boolean.pipe(Schema.optional),
})

const RenamePayload = Schema.Struct({
  from: RelativePath,
  to: RelativePath,
})

const WatchQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

export const WatchEvent = Schema.Struct({
  path: Schema.String,
  type: Schema.Literals(["add", "change", "unlink"]),
  timestamp: Schema.Number,
}).annotate({ identifier: "FileSystem.WatchEvent" })

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.stat", "/api/fs/stat", {
      query: StatQuery,
      success: Location.response(FileSystem.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.stat",
          summary: "Stat path",
          description: "Return one filesystem entry (file or directory) for a path relative to the location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.write", "/api/fs/write", {
      query: LocationQuery,
      payload: WritePayload,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.write",
          summary: "Write file",
          description: "Write bytes to a path relative to the location. `content` is base64-encoded.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.mkdir", "/api/fs/mkdir", {
      query: LocationQuery,
      payload: MkdirPayload,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.mkdir",
          summary: "Make directory",
          description: "Create a directory (recursively by default) at a path relative to the location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.remove", "/api/fs/remove", {
      query: LocationQuery,
      payload: RemovePayload,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.remove",
          summary: "Remove path",
          description: "Remove a file or (with `recursive: true`) a directory at a path relative to the location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.rename", "/api/fs/rename", {
      query: LocationQuery,
      payload: RenamePayload,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.rename",
          summary: "Rename path",
          description: "Rename a path to a new path, both relative to the location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.watch", "/api/fs/watch", {
      query: WatchQuery,
      success: HttpApiSchema.StreamSse({ data: WatchEvent }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.watch",
          summary: "Watch filesystem",
          description:
            "Subscribe to filesystem events under the location. Events for the same path are debounced and emitted after 200ms of quiet.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
