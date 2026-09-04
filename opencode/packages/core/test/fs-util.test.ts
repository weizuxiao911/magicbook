/**
 * fs-util.test.ts — path normalize / cross-platform sanity
 *
 * numas patch 2026-09-04: bare drive letter (e.g. "D:") used to round-trip
 * unchanged through windowsPath, then path.win32.resolve turned it into
 * the per-drive CWD instead of the drive root. The picker silently switched
 * the user to the launch project; the explorer never got the real D:\ root.
 *
 * Fix lives in fs-util.ts:268 (.replace(/^([A-Za-z]):$/, '$1:\\')).
 *
 * The matrix below mirrors the regex chain there. On win32 the platform
 * guard is a no-op and the same regex runs; on non-win32 we run it directly
 * (windowsPath would otherwise short-circuit to identity).
 *
 * `path.win32` cases are simulated with Node's path.win32 module so the test
 * works on macOS / Linux CI. The Windows host is the source of truth — this
 * test catches regressions in the regex chain, not in Node's path module.
 */
import { describe, expect, test } from "bun:test"
import path from "path"

// Mirror of fs-util.ts:259-268. Keep in sync.
const normalizeWindowsPath = (p: string): string =>
  p
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^([A-Za-z]):$/, (_, drive) => `${drive.toUpperCase()}:\\`)

const resolve = (p: string): string => path.win32.resolve(p)

describe("windowsPath regex (mirrors fs-util.ts)", () => {
  test("bare drive letter gets trailing backslash (drive root)", () => {
    expect(normalizeWindowsPath("D:")).toBe("D:\\")
    expect(normalizeWindowsPath("C:")).toBe("C:\\")
    expect(normalizeWindowsPath("Z:")).toBe("Z:\\")
  })

  test("lowercase bare drive letter is uppercased", () => {
    expect(normalizeWindowsPath("d:")).toBe("D:\\")
    expect(normalizeWindowsPath("c:")).toBe("C:\\")
  })

  test("drive-relative forms are NOT converted (must keep their meaning)", () => {
    // D:foo resolves to <D drive CWD>/foo, NOT D:\foo
    expect(normalizeWindowsPath("D:foo")).toBe("D:foo")
    expect(normalizeWindowsPath("D:.")).toBe("D:.")
    expect(normalizeWindowsPath("D:..")).toBe("D:..")
    expect(normalizeWindowsPath("D:foo/bar")).toBe("D:foo/bar")
  })

  test("absolute drive-rooted paths are untouched", () => {
    expect(normalizeWindowsPath("D:\\")).toBe("D:\\")
    expect(normalizeWindowsPath("D:/")).toBe("D:/")
    expect(normalizeWindowsPath("D:\\projects")).toBe("D:\\projects")
    expect(normalizeWindowsPath("D:/projects/numas")).toBe("D:/projects/numas")
  })

  test("POSIX-style Linux → Windows mapping still works", () => {
    expect(normalizeWindowsPath("/D:")).toBe("D:/")
    expect(normalizeWindowsPath("/d:")).toBe("D:/")
    expect(normalizeWindowsPath("/D:/projects")).toBe("D:/projects")
    expect(normalizeWindowsPath("/D:/projects/numas")).toBe("D:/projects/numas")
    expect(normalizeWindowsPath("/cygdrive/d")).toBe("D:/")
    expect(normalizeWindowsPath("/cygdrive/d/projects")).toBe("D:/projects")
    expect(normalizeWindowsPath("/mnt/d")).toBe("D:/")
    expect(normalizeWindowsPath("/mnt/c/Users")).toBe("C:/Users")
  })

  test("POSIX / is NOT modified by windowsPath (Windows resolves it via process.cwd)", () => {
    expect(normalizeWindowsPath("/")).toBe("/")
  })

  test("POSIX .. is NOT modified by windowsPath", () => {
    expect(normalizeWindowsPath("..")).toBe("..")
  })

  test("drive root can round-trip resolve() with the patch", () => {
    // Without patch: path.win32.resolve("D:") = "<process CWD on D drive>"
    //   (per-drive CWD, often the launch dir — this is the bug)
    // With patch:   windowsPath("D:") = "D:\", then resolve("D:\") = "D:\"
    //   (drive root — what users expect)
    expect(resolve("D:")).not.toBe("D:\\") // documents the bug on bare input
    expect(resolve(normalizeWindowsPath("D:"))).toBe("D:\\") // patch fixes it
    expect(resolve(normalizeWindowsPath("C:"))).toBe("C:\\")
  })

  test("absolute drive-rooted path resolves to itself (no behavior change)", () => {
    expect(resolve("D:\\")).toBe("D:\\")
    expect(resolve("D:\\projects")).toBe("D:\\projects")
  })

  test("drive-relative paths still resolve via per-drive CWD (intentional)", () => {
    // Documenting the (correct, by-spec) drive-relative behavior so future
    // refactors don't accidentally break it.
    const r1 = resolve("D:foo")
    expect(r1.endsWith("foo")).toBe(true)
    // path.win32.resolve("D:foo") on a process launched from D: drive =
    // "<per-drive CWD>\\foo". On the CI box (Mac) it lands under
    // <workspace>/D:foo (the simulated drive CWD).
    expect(r1.startsWith("D:\\")).toBe(true)
  })
})

describe("FSUtil.contains after patch (drive-root edge case)", () => {
  // Simulates what filesystem.ts:108 does on the server:
  //   absolute = path.resolve(directory, '.')   <-- this used to silently land
  //                                              in <per-drive CWD> for "D:"
  //   then FSUtil.contains(directory, absolute) is the guard
  // After patch: callers run windowsPath(directory) first so 'D:' becomes 'D:\'
  // and contains("D:\\", "D:\\") holds. We simulate the contains logic
  // directly to avoid pulling in the whole FSUtil layer.
  const contains = (parent: string, child: string): boolean => {
    const r = path.win32.relative(parent, child)
    return r === "" || (!path.win32.isAbsolute(r) && r !== ".." && !r.startsWith(`..\\`))
  }

  test("contains('D:\\\\', 'D:\\\\') returns true (drive root contains itself)", () => {
    // After patch, callers normalize directory to "D:\\" first
    expect(contains("D:\\", "D:\\")).toBe(true)
  })

  test("contains('D:\\\\', 'D:\\\\projects') returns true", () => {
    expect(contains("D:\\", "D:\\projects")).toBe(true)
  })

  test("contains('D:\\\\', 'D:\\\\projects\\numas') returns true (deep subdir)", () => {
    expect(contains("D:\\", "D:\\projects\\numas")).toBe(true)
  })

  test("documents the BUG: contains('D:', 'D:\\\\') returns false on bare drive", () => {
    // path.win32.relative("D:", "D:\\") = "..\\..\\..\\.." because "D:" has no
    // trailing separator and is treated as a non-absolute path. This is what
    // blew up the FSUtil.contains guard before the patch. After the patch,
    // callers don't pass "D:" — they pass windowsPath("D:") = "D:\\" which
    // sidesteps this entirely. This test just locks the bug in place so a
    // future refactor of FSUtil.contains can be reviewed deliberately.
    expect(contains("D:", "D:\\")).toBe(false)
  })
})

describe("end-to-end picker scenario (simulated)", () => {
  // Reproduces what the picker does on Windows after setWorkspace('D:'):
  // 1. URL ?directory=D: → x-opencode-directory: D: header
  // 2. server defaultDirectory reads header, calls windowsPath(header)
  // 3. filesystem.ts list handler does path.resolve(directory, '.') to walk
  // 4. result is what /api/fs/list?path=. returns
  //
  // Before patch: directory = D:, resolve = <launch dir>  → wrong list
  // After patch:  directory = D:\, resolve = D:\          → real D drive root

  test("'D:' input lands on D:\\ drive root (the bug fix)", () => {
    const input = "D:"
    const normalized = normalizeWindowsPath(input)
    const absolute = resolve(path.win32.join(normalized, "."))
    expect(absolute).toBe("D:\\")
  })

  test("'C:' input lands on C:\\ drive root (case-insensitive)", () => {
    const input = "c:"
    const normalized = normalizeWindowsPath(input)
    const absolute = resolve(path.win32.join(normalized, "."))
    expect(absolute).toBe("C:\\")
  })

  test("'/D:' POSIX form still maps to D:\\", () => {
    const input = "/D:"
    const normalized = normalizeWindowsPath(input)
    const absolute = resolve(path.win32.join(normalized, "."))
    expect(absolute).toBe("D:\\")
  })
})
