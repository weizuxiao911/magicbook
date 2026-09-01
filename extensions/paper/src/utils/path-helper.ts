/**
 * 字符串路径 basename 工具，替代 `path.basename` / `path.parse`。
 * 在 web 运行时下 `node:path` 不可用，且 fsPath 也不可靠（kt-ext 协议下拿不到真实文件路径）。
 * 这里只处理用于展示目的的 tabTitle / displayTitle，逻辑保持与原 `path.basename` / `path.parse().name` 一致：
 *   - 接受 POSIX 与 Windows 路径分隔符
 *   - basename 返回最后一段
 *   - noExt 去掉末尾扩展名
 */
function splitSegments(input: string): string[] {
  return input.split(/[\\/]+/).filter(Boolean)
}

export function uriBasename(filePath: string): string {
  if (!filePath) return ''
  const segments = splitSegments(filePath)
  if (segments.length === 0) return ''
  return segments[segments.length - 1]
}

export function uriBasenameWithoutExt(filePath: string): string {
  const base = uriBasename(filePath)
  if (!base) return ''
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex <= 0) return base
  return base.slice(0, dotIndex)
}