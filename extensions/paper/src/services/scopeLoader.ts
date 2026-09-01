/**
 * Scope loader — src/services/scopeLoader.ts
 *
 * 从 `.env` 读取 labCode / courseCode (sumi-edu 模式 source of truth).
 * 不解析整个 YAML, 仅按行正则在多行文本中匹配 `labCode:` / `courseCode:` 两字段.
 * 不引入 YAML 依赖 (js-yaml 体积 ~1.5MB).
 */

import * as vscode from 'vscode'

export type AppScope = {
  labCode: string
  courseCode: string
}

/**
 * 正则解析多行文本, 提取 labCode / courseCode 两字段的值.
 * 支持带双引号 / 不带 / 数字 / 空字符串: labCode: "0518" / 0518 / "" / ''
 * (单引号 YAML 字符串不剥离 — 当前 app/.env 不使用, 后续若启用需扩 regex)
 */
export function parseScopeEnv(text: string): AppScope {
  const labMatch = text.match(/^\s*labCode:\s*"?([^"\n]*)"?\s*$/m)
  const courseMatch = text.match(/^\s*courseCode:\s*"?([^"\n]*)"?\s*$/m)
  return {
    labCode: labMatch?.[1] ?? '',
    courseCode: courseMatch?.[1] ?? ''
  }
}

/**
 * 经 `vscode.workspace.fs.readFile` 读取 `.env` 文件.
 * 调用方需自行 catch 错误 (无 workspace / 文件不存在 / 权限 / IO 错误).
 *
 * 注意: **不**读 `context.extensionUri` — 那是扩展安装目录, `.env` 不在里面 (vsce 打包排除).
 * 实际 `.env` 在用户打开的工作区目录下:
 *   - **sumi-edu 容器**: workspace folder 就是用户的 `app` 目录, `.env` 在 `<folder>/.env`
 *   - **dev mode (F5)**: workspace folder 是仓库根, `.env` 在 `<folder>/app/.env`
 *
 * 同时尝试两种路径以兼容两种场景. 多 workspace (multi-root) 时按顺序尝试每个
 * workspaceFolder, 任一命中即返回.
 */
export async function loadScopeFromAppEnv(): Promise<AppScope> {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    throw new Error('no workspace folder')
  }
  let lastError: unknown
  for (const folder of folders) {
    // 候选路径: dev mode (<folder>/app/.env) 先试, sumi-edu 容器 (<folder>/.env) 后试.
    // 顺序无关 (任一命中即返回), 但 dev mode 优先可让 F5 时更快找到.
    const candidates = [
      vscode.Uri.joinPath(folder.uri, 'app', '.env'),
      vscode.Uri.joinPath(folder.uri, '.env')
    ]
    for (const uri of candidates) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri)
        return parseScopeEnv(new TextDecoder().decode(bytes))
      } catch (e) {
        lastError = e
      }
    }
  }
  throw lastError ?? new Error('.env not found in any workspace folder')
}