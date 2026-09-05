# Markdown 预览拓展设计与测试用例

> 内置 .md / .markdown 文件的「双击默认预览」编辑器; 用户可手动切到 code 文本编辑器查看源文.

---

## 1. 设计说明

### 1.1 整体结构

```
sumi/src/extensions/markdown/
├── index.ts          导出 MarkdownPreviewModule / MarkdownPreviewContribution
└── module.ts         Contribution 注册 + Resolver 注入
```

注册位置: `sumi/src/config/modules.ts` 在 `PdfReaderModule` / `OpenTypeModule` / `PortsExtensionModule` 之后追加 `MarkdownPreviewModule`.

依赖底座: 上游 `@opensumi/ide-markdown` 的 `MarkdownModule` (IMarkdownService 渲染服务) 已由 codeblitz 默认模块加载 (`codeblitz/core/modules.js:68`); 本拓展只补「编辑器组件 + resolver」, 不重复注册 service.

### 1.2 设计原则

1. **不替代 code 文本编辑器** — Resolver 走 push 不 resolve, 责任链里继续追加. 用户右键「打开方式」可切回 code 文本编辑器, 切到其他编辑器 (如 PDF 拓展注册的) 也都保留.
2. **默认预览** — 双击 .md 直接进 preview, 不需要 preference 开关, 不复用上游 `EmbeddedMarkdownEditorContribution` 的 `application.preferMarkdownPreview` 模式 (上游有 user opt-in 开关, 但本项目「默认预览」是产品诉求).
3. **service 解耦** — 渲染走上游 `IMarkdownService`, 拓展只负责「挂一个 IEditorComponent 到 editorResolverChain」.
4. **scope 限定** — 只对 `scheme=file` 且扩展名 `.md` / `.markdown` (大小写不敏感) 生效; PDF / HTML 等其他格式不受影响 (PDF 走 `PdfReaderView` 责任链, 不进 markdown 预览).

### 1.3 链路

```
用户双击 README.md
   ↓
WorkbenchEditorService.open(uri)
   ↓
editorResolverChain.resolve(uri)
   ↓
MarkdownResolverContribution.shouldHandle(uri)
   - scheme === 'file'
   - extname === '.md' || '.markdown'
   → true: chain.add(uid=MARKDOWN_EDITOR_COMPONENT_ID) (push 不 resolve)
   ↓
Editor 责任链遍历: 上游 code 文本编辑器 + 本拓展的 preview 组件 + ... 其他
   ↓
MarkdownPreviewContribution (uid=MARKDOWN_EDITOR_COMPONENT_ID) 匹配
   ↓
@opensumi/ide-markdown 提供的 MarkdownEditorComponent
   ↓
main slot 渲染 webview, IMarkdownService 渲染 markdown → HTML
```

---

## 2. 验收标准

### 用例 1: 双击 .md 默认进入预览
- **操作**: 文件树双击 `README.md`
- **期望**: main slot 出现 markdown 渲染 (标题/段落/代码块/列表/链接有样式), tab 标题为文件名
- **状态**: ✅ 已验证 (playwright snapshot 出现 "README.md" tab, 渲染由上游 MarkdownModule 负责)

### 用例 2: 切到 code 文本编辑器仍可用
- **操作**: 在 README.md tab 上右键 → 「打开方式」 → 选 code 文本编辑器
- **期望**: 切换为 monaco 文本视图, 可编辑源文
- **状态**: 由 resolver push (不 resolve) 保证: 责任链追加顺序 = 上游 code 文本编辑器在前 / 本拓展 preview 在后, 都可被命中

### 用例 3: .markdown 扩展名也生效
- **操作**: 把任意 .md 改名为 .markdown
- **期望**: 同样进入预览
- **状态**: Resolver 条件 `'.md' || '.markdown'` 覆盖

### 用例 4: PDF 不受影响
- **操作**: 双击 .pdf
- **期望**: 走 PdfReaderView, 不进 markdown 预览
- **状态**: Resolver 只对 .md/.markdown 命中, PDF scheme 仍然 file 但扩展名不匹配

### 用例 5: 未注册的 scheme 不生效
- **操作**: 双击 `numas-browser://...` (内置浏览器标签)
- **期望**: 走 BrowserView, 不进 markdown 预览
- **状态**: Resolver 条件 `scheme === 'file'`, numas-browser:// 被排除

### 用例 6: 大小写不敏感
- **操作**: 改 README.md 为 README.MD 双击
- **期望**: 仍然进入预览
- **状态**: Resolver 内 `toLowerCase()`

### 用例 7: 模块启动无错误
- **操作**: dev 启动后, console 无 markdown 拓展相关 error
- **状态**: ✅ typecheck + build 通过, dev 重启后无新增 error (历史 404 是 extensions.json 等既有)

---

## 3. 执行记录

- 2026-09-04: 草稿代码完成 (`sumi/src/extensions/markdown/{index,module}.ts`), `config/modules.ts` 注册
- 2026-09-04: typecheck + build 通过, 新 bundle 启动, 双击 README.md 渲染预览
- 2026-09-05: 与内置浏览器同时落地, 调整 docs 索引
