import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

/** Defensive: strip a leading "/" from Windows drive paths (e.g. "/D:/projects" -> "D:/projects").
 *  Some codeblitz/opensumi paths surface a leading slash on Windows; without this the server
 *  treats the value as a POSIX root and resolves the wrong directory. */
function normalizeDirectory(value: string): string {
  if (!value) return value
  return FSUtil.windowsPath(value)
}

function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  // numas: workspace dir is the x-opencode-directory header only. Query overrides
  // (?location[directory], ?directory) are intentionally dropped — the client SDK
  // normalizes the header from the URL ?directory= source-of-truth, and accepting
  // query overrides would let stale / conflicting values reach the instance.
  const header = request.headers["x-opencode-directory"]
  const rawDirectory = header ? decode(header) : process.cwd()
  const directory = normalizeDirectory(rawDirectory)
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-opencode-workspace"]
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* effect.pipe(Effect.provide(locations.get(ref(request))))
      }),
    )
  }),
)
