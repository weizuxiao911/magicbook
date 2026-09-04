import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions, validateWebUIOption } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { networkInterfaces } from "os"
import { spawn } from "child_process"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const webUIBad = validateWebUIOption(opts.webUI)
    if (webUIBad) return yield* fail(webUIBad)
    const server = yield* Effect.promise(() => Server.listen(opts))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    const displayUrl =
      opts.hostname === "0.0.0.0" ? `http://localhost:${server.port}` : server.url.toString()

    if (opts.hostname === "0.0.0.0") {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, `http://localhost:${server.port}`)
      const networkIPs = getNetworkIPs()
      for (const ip of networkIPs) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Network access:    ", UI.Style.TEXT_NORMAL, `http://${ip}:${server.port}`)
      }
      if (opts.mdns) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "  mDNS:              ", UI.Style.TEXT_NORMAL, `${opts.mdnsDomain}:${server.port}`)
      }
    } else {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
    }

    // Pre-warm InstanceStore boot by hitting /agent and /provider from the
    // server process itself. The macOS `open(1)` binary's first invocation
    // per process takes 200-500ms in LaunchServices resolving the URL
    // handler, and the resulting child process tree holds onto libuv
    // worker threads long enough to 499 the very first /agent request that
    // lands during InstanceStore boot. Schedule a warmup fetch so the boot
    // fork runs to completion BEFORE the browser opens, and defer the
    // browser open via setTimeout(1500) so it lands in libuv's timer phase
    // only after the initial /agent request has completed. Spawn inside
    // /bin/sh with `&` so the shell exits immediately and open(1) runs in
    // a brand-new process tree.
    const baseUrl = `http://127.0.0.1:${server.port}`
    const warmupHandle = setTimeout(() => {
      // fire-and-forget; failures are fine — subsequent real requests will retry
      Promise.allSettled([
        fetch(`${baseUrl}/agent`).catch(() => {}),
        fetch(`${baseUrl}/provider`).catch(() => {}),
        fetch(`${baseUrl}/path`).catch(() => {}),
        fetch(`${baseUrl}/skill`).catch(() => {}),
        fetch(`${baseUrl}/command`).catch(() => {}),
      ]).catch(() => {})
    }, 50)
    warmupHandle.unref()

    const handle = setTimeout(() => {
      try {
        const child = spawn("/bin/sh", ["-c", `open "${displayUrl.replace(/"/g, '\\"')}" &`], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
        child.on("error", () => {})
        child.unref()
      } catch {
        // ignore — opening the browser is best-effort
      }
    }, 1500)
    handle.unref()

    yield* Effect.never
  }),
})
