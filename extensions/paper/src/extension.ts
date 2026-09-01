import * as vscode from 'vscode'

import { PAPER_CUSTOM_EDITOR_VIEW_TYPE, PaperCustomEditorProvider } from './panels/PaperCustomEditorProvider'
import { defaultConfig, setPluginConfig, type PluginApiConfig } from './services/config'
import { loadScopeFromAppEnv } from './services/scopeLoader'
import { initialize as initializeSessionProvider, dispose as disposeSessionProvider, getEnvironment } from './services/sessionProvider'

const SUMI_EDU_CONFIG_GET = 'sumi-edu.config.get'

export async function activate(context: vscode.ExtensionContext) {
  // 启动期把 globalState 中持久化的 scope.labCode 灌回 config；
  // auth 段不经 config.auth (始终空) 走 sessionProvider 内部 cache + http.ts buildHeaders,
  // standalone 模式 session 永久 null, 请求匿名.
  const savedLabCode = context.globalState.get<string>('scope.labCode') ?? ''
  setPluginConfig({
    scope: { ...defaultConfig.scope, labCode: savedLabCode }
  })

  // 阻塞式探测运行环境 + (sumi-edu 模式) 启动后台订阅循环.
  // standalone VS Code 模式: 快速返回, session 永久 null.
  await initializeSessionProvider(context)

  // sumi-edu 模式: 拉取 4 个业务 API URL (communityBaseUrl / communityPageBaseUrl / codeTestUrl / codePlayerUrl).
  // 命令无外部依赖, 同步返回; command-not-found 仅 standalone 模式会出现 (上面已过滤).
  // standalone 模式 config.api.* 保持空字符串, 后续 API 请求会失败 (当前 standalone 模式未对接).
  if (getEnvironment() === 'sumi-edu') {
    try {
      const api = await vscode.commands.executeCommand<PluginApiConfig>(SUMI_EDU_CONFIG_GET)
      if (api) {
        setPluginConfig({ api })
      }
    } catch (e) {
      console.warn('[config] sumi-edu.config.get failed, config.api.* stays empty:', e)
    }

    // sumi-edu 模式: 用 app/.env 覆盖 (含 labCode + courseCode).
    // 读失败 (无 workspace / app/.env 不存在 / 权限 / IO 错误) → fallback 到上一步 globalState 灌的值 + console.warn.
    // app/.env 是 source of truth; 下次激活时 webview 改的 labCode 会被 app/.env 覆盖.
    try {
      const envScope = await loadScopeFromAppEnv()
      setPluginConfig({
        scope: { ...defaultConfig.scope, labCode: envScope.labCode, courseCode: envScope.courseCode }
      })
    } catch (e) {
      console.warn('[scope] failed to read app/.env, fallback to globalState:', e)
    }
  }

  const customEditorDisposable = vscode.window.registerCustomEditorProvider(
    PAPER_CUSTOM_EDITOR_VIEW_TYPE,
    new PaperCustomEditorProvider(context),
    {
      webviewOptions: {
        retainContextWhenHidden: true
      },
      supportsMultipleEditorsPerDocument: false
    }
  )
  context.subscriptions.push(customEditorDisposable)
}

export async function deactivate() {
  disposeSessionProvider()
}