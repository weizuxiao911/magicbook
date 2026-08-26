/**
 * html-preview — HTML 文件预览拓展（TS 实现）
 *
 * customEditor: *.html 打开时用 webview 渲染预览（可切换回文本编辑）
 * 命令: HTML: 预览当前文件（webview panel 渲染当前编辑器 html）
 *
 * webview 说明:
 *   - 本拓展的 webview 内容 = 用户 html 文件内容（直接运行; webview 本身即 iframe,
 *     enableScripts 使 sandbox 含 allow-scripts, 用户 html 的 JS 可执行）
 *   - 注册时 webviewOptions.enableScripts 不会传到 customEditor 的 webview 创建
 *     （allowScripts 默认 false）; 需在 resolve 里运行时设置 webview.options
 *   - 复杂 webview UI 按项目规范放 webview/ 目录单独维护（本拓展无独立 UI）
 *
 * 恢复自愈: 容器恢复打开的 tab 只建了容器, customEditor 的 webview 懒加载（非激活/未走
 * 完整打开流程时不渲染）. 参照 paper 扩展的 createRestoreSelfHeal: 启动后定时检查已打开
 * 但无 panel 的 .html 文档（内容非空）, 用 vscode.openWith 重新打开触发渲染.
 */

import * as vscode from 'vscode';

const PREVIEW_VIEW_TYPE = 'htmlPreview';

/** 校验是否为有效预览内容（非空、有 body 标签才算渲染过） */
function isRenderable(html: string): boolean {
  return typeof html === 'string' && html.trim().length > 0;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('[html-preview] activate called');
  /** uri -> panel（当前活跃的 preview panel） */
  const panels = new Map<string, vscode.WebviewPanel>();

  // customEditor provider: html 文件 → webview 渲染预览（文档变更实时刷新）
  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      console.log('[html-preview] resolveCustomTextEditor:', document.uri.toString());
      panels.set(document.uri.toString(), webviewPanel);
      // 注册时 webviewOptions.enableScripts 不会传到 customEditor 的 webview 创建（allowScripts 默认 false）;
      // 运行时设置 options 确保 iframe sandbox 含 allow-scripts（用户 html 的 JS 可执行）
      webviewPanel.webview.options = { enableScripts: true, enableForms: true };
      // 取渲染内容: 优先 document（customEditor doc 可能内容未加载/为空）; 空则从 fs 兜底读文件
      const readContent = async (): Promise<string> => {
        const docText = document.getText();
        if (isRenderable(docText)) return docText;
        try {
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const text = new TextDecoder('utf-8').decode(bytes);
          if (isRenderable(text)) return text;
        } catch (e) {
          console.warn('[html-preview] fs readFile fallback 失败:', e);
        }
        return '';
      };
      // 赋值内容。opensumi webview 的 _sendToWebview 在 _isListening=false 时会丢弃内容
      // （WebviewMounter.doMount 视容器尺寸控制 listening）; 故内容就绪后要多次间隔重发,
      // 确保某次落在 listening=true 时刻, 否则 iframe 一直是空宿主页.
      let timers: ReturnType<typeof setTimeout>[] = [];
      const pushContent = (html: string) => {
        timers.forEach((t) => clearTimeout(t));
        timers = [];
        // 立即 + 多档延迟重发（覆盖 container 布局/doMount 完成前的空窗期）
        [0, 300, 1000, 2500, 5000].forEach((delay) => {
          timers.push(setTimeout(() => { try { webviewPanel.webview.html = html; } catch { /* ignore */ } }, delay));
        });
      };
      const update = async () => {
        const html = await readContent();
        if (isRenderable(html)) pushContent(html);
      };
      // 恢复/懒加载打开时 document 内容可能尚未加载完（getText 为空）→ 延迟重试更新
      // （参照 paper 扩展 scheduleReload; 避免 webview 一直是空预览）
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const ensureRendered = (attempt: number) => {
        void readContent().then((html) => {
          if (isRenderable(html)) {
            pushContent(html);
            return;
          }
          if (attempt < 60) retryTimer = setTimeout(() => ensureRendered(attempt + 1), 500);
        });
      };
      ensureRendered(0);
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) void update();
      });
      webviewPanel.onDidDispose(() => {
        if (retryTimer) clearTimeout(retryTimer);
        timers.forEach((t) => clearTimeout(t));
        panels.delete(document.uri.toString());
        changeSub.dispose();
      });
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PREVIEW_VIEW_TYPE, provider, {
      webviewOptions: { enableScripts: true },
    }),
  );

  // 恢复自愈: 检查「已打开但无 preview panel」的 .html 文档（内容非空）→ openWith 重开渲染
  // （参照 paper 扩展 createRestoreSelfHeal; 避免恢复/懒加载时 webview 内容为空）
  let selfHealTimer: ReturnType<typeof setTimeout> | undefined;
  const selfHealCheck = (attempt: number) => {
    const orphans = vscode.workspace.textDocuments.filter(
      (d) => d.uri.path.endsWith('.html') && !panels.has(d.uri.toString()),
    );
    if (orphans.length) {
      for (const d of orphans) {
        if (isRenderable(d.getText())) {
          console.log('[html-preview] self-heal reopen:', d.uri.toString());
          void vscode.commands.executeCommand('vscode.openWith', d.uri, PREVIEW_VIEW_TYPE);
          return;
        }
      }
      // 都还没内容（文档未加载完）→ 稍后重试
      if (attempt < 10) selfHealTimer = setTimeout(() => selfHealCheck(attempt + 1), 3000);
    }
  };
  selfHealTimer = setTimeout(() => selfHealCheck(0), 5000);
  context.subscriptions.push({ dispose: () => selfHealTimer && clearTimeout(selfHealTimer) });

  // 命令: 预览当前文件（webview panel）
  context.subscriptions.push(
    vscode.commands.registerCommand('htmlPreview.show', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'html') {
        void vscode.window.showInformationMessage('当前没有打开的 HTML 文件');
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        PREVIEW_VIEW_TYPE,
        'HTML Preview',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      const update = () => {
        panel.webview.html = editor.document.getText();
      };
      update();
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === editor.document) update();
      });
      panel.onDidDispose(() => changeSub.dispose());
    }),
  );
}