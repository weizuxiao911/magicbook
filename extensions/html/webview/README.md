# html-preview webview

本拓展的 webview 内容 = 用户 html 文件内容（直接运行）：

- webview 本身即 iframe，`enableScripts` 使 sandbox 含 `allow-scripts`，用户 html 的 JS 可执行
- 注册时 `webviewOptions.enableScripts` 不会传到 customEditor 的 webview 创建（allowScripts 默认 false），需在 resolve 里运行时设置 `webview.options`
- 本拓展无独立 webview UI；若后续需要复杂 webview 界面（工具栏、iframe 宿主等），在此目录单独维护（参照 paper 的 `webview/` 构建方式）