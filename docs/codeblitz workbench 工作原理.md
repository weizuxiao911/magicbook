# codeblitz workbench 工作原理

> numas 对 codeblitz/opensumi 编辑器 tab 持久化 (workbench.json) 与欢迎页机制的调查记录。
> 2026-09-05: 用户拍板「全切官方机制」后落地的架构事实 + 遗留问题 (官方恢复在 numas 环境下未生效, 待办)。
> 相关代码均为 node_modules 只读事实 (opensumi ide-editor / codeblitz ide-sumi-core), 不做修改。

---

## 1. 一句话总览

codeblitz (opensumi) 自带「编辑器 tab 布局持久化」: 打开的编辑器 tabs 序列化成 grid 状态存
`workbench.json` (framework storage, 按 workspace 隔离), 启动时**先恢复 tabs、后触发
`onDidRestoreState` (welcome 等贡献的判定点)** — 官方时序自洽, 恢复过 tab 就不会误开欢迎页。

```
打开/关闭/切换 tab
  → EditorGroup.getState() / serialize()        (opensumi ide-editor grid)
  → saveOpenedResourceState() (跳过 _restoring 期)
  → openedResourceState.set('grid', state)       (storage WORKBENCH scope)
  → workbench.json (文件落点 ~/.codeblitz/datas/workbench.json, 经 file scheme → numas fs provider)

启动
  → WorkbenchEditorService.doInitialize()
  → getStorage(WORKBENCH) → openedResourceState
  → restoreState(): openedResourceState.get('grid') → topGrid.deserialize(state)
  → EditorGroup.restoreState(): uris 逐个 doOpen (backend, preview:false, deletedPolicy:skip)
  → 全部完成后 → 遍历 contribution.onDidRestoreState()   ← welcome 判定在此刻
```

---

## 2. 存储层: workbench.json

### 2.1 scope 与落点

- `STORAGE_NAMESPACE.WORKBENCH` (`@opensumi/ide-core-common/lib/storage.js`): scoped URI `workbench`
- 文件落点: `~/.codeblitz/datas/workbench.json` (codeblitz home = 用户 home 的 `.codeblitz`; mac = `~/`, 容器 = `/root/`)
- **读写链路 = file scheme → numas CustomFileSystemProvider → opencode** (依赖 home 锚点, 已修: 避坑 #20)
  - 早期时序风险: 启动极早期 (home 锚点注入前) 读 workbench.json 会失败 → 恢复落空 (见 §7 遗留)

### 2.2 文件结构 (按 workspace 隔离)

```json
{
  "expires": 1789827525808,
  "file:///Users/weizuxiao/Documents/numas": {
    "grid": "{\"editorGroup\":{\"uris\":[\"file:///.../README.md\"],\"current\":\"file:///.../README.md\",\"previewIndex\":-1}}"
  }
}
```

- 外层 key = workspace 目录 (workspaceDir 的 file:// URI), 多 workspace 互不污染
- `grid` = EditorGrid.serialize() 的 JSON 字符串
- 单 group 形态: `{ editorGroup: { uris[], current?, previewIndex } }`
- 多 split 形态: `{ splitDirection, children: [grid...] }`
- 空白 group (无 uris 且非根) serialize 返回 null → 不落盘

## 3. 保存链路 (谁写 workbench.json)

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| EditorGroup.getState() | opensumi ide-editor workbench-editor.service.js | 收集当前 group 的 uris/preview/current |
| EditorGrid.serialize() | ide-editor/lib/browser/grid/grid.service.js | grid 树序列化 (单 group / split 树) |
| WorkbenchEditorService.saveOpenedResourceState() | workbench-editor.service.js:255 | `if (this._restoring) return` + `openedResourceState.set('grid', state)` |
| openedResourceState | doInitialize 时 `getStorage(STORAGE_NAMESPACE.WORKBENCH)` | storage 实例 (含 debounce 写盘) |

触发: tab 打开/关闭/切换 → `onDidGridAndDesendantStateChange` → 保存 (去重节流在 storage 层)。
`_restoring` 期间的保存被跳过 (恢复过程不写回, 防清空)。

## 4. 恢复链路 (谁读 workbench.json)

```
WorkbenchEditorService.restoreState()            (workbench-editor.service.js:314)
  state = appConfig.disableRestoreEditorGroupState ? 空 : openedResourceState.get('grid', 空)
  topGrid.deserialize(state)                     (grid.service.js — 建 grid 树)
    → EditorGroup.restoreState(state.editorGroup) (workbench-editor.service.js:1834)
        uris.forEach → doOpen(uri, {disableNavigate, backend, preview:false, deletedPolicy:'skip'})
        恢复 current 激活 (失败 fallback 到 resources[0])
  → gridReady = true
  → editorRestorePromises 全部完成 → 遍历 onDidRestoreState()   ← welcome 判定点
```

**关键时序**: onDidRestoreState 在所有 group restore 完成后才触发 → 官方 welcome 检查
`getAllOpenedUris()` 时恢复的 tabs 已在 → 不会误开欢迎页。**这是官方机制自洽的核心。**

`disableRestoreEditorGroupState`: 仅 codeblitz renderDiffViewer 场景设 true; numas 正常 app 不设 (恢复开启)。

## 5. 欢迎页官方机制

`@codeblitzjs/ide-sumi-core/lib/client/welcome/welcome.contributon.js` WelcomeContribution:

- 注册: scheme `welcome` 的 EditorComponent (uid `welcome`, `ONE_PER_WORKBENCH`) + resolver + resource provider (tab 名 = `menu.help.welcome` 本地化 "欢迎使用")
- **UI 替换扩展点: `RuntimeConfig.WelcomePage?: React.FC`** — 注入自定义组件即替换官方默认欢迎 UI
- 打开规则 (`onDidRestoreState`):
  1. `getAllOpenedUris()` 非空 且 配了 `startupEditor` → 按 'readme'/'welcomePage' 处理
  2. 配了 `defaultOpenFile` → 打开指定文件
  3. `else if (getAllOpenedUris().length === 0)` → `openWelcome()` (open `welcome://`)
- `startupEditor` 默认缺省 → 走 3 (无打开资源就开欢迎页)

## 6. numas 现状 (2026-09-05 用户拍板: 全切官方)

**已删 (自建第二套, 与官方机制重复/时序摩擦):**
- `sumi/src/extensions/welcome/module.ts` + `index.ts` — 自建 scheme welcome provider/component/resolver + 自己的 onDidRestoreState 打开逻辑 (曾与官方双开欢迎页、互相时序竞争)
- `sumi/src/contribution/editor-session/` — 自建 localStorage tab 记忆 (`editor.restore.{ws}.uris`, 500ms 后恢复) + App.tsx stash 暂存; 与官方恢复并存 → 欢迎误判根源之一
- `modules.ts` 两处注册移除; App.tsx `stashSavedEditorUris()` 删除

**保留/新增:**
- `src/extensions/welcome/WelcomeView.tsx` — numas 欢迎 UI 组件 (🐮 品牌)
- `src/config/runtime.ts` — `runtimeConfig.WelcomePage = WelcomeView` (官方扩展点注入, 替换官方欢迎 UI)
- tab 恢复/欢迎判定 = 官方 workbench + 官方 WelcomeContribution

**预期行为:**
- 无打开文件 → 官方开欢迎页 (tab 名"欢迎使用", 内容 = numas UI)
- 有 workbench 缓存 → 官方恢复 tabs, 不开欢迎页
- 无双开欢迎 / 无 welcome: 进持久化 (官方 uris 只存 file:// 真实资源)

## 7. 遗留问题 (官方恢复在 numas 环境未生效 — 待办)

实测 (本地 dev): workbench.json **已正常写入** (开 README.md → uris=[README.md]), 但**刷新后 tab 未恢复**,
欢迎页被官方判定"无打开资源"而打开。console 无错误。

疑点 (未定位):
- workbench.json 读取走 file scheme (home 锚点链), 恢复发生在 doInitialize (编辑器服务初始化),
  可能赶在 home 锚点/opencode /path 注入前 → storage 读失败/空 → 恢复落空 → 欢迎页误判
- numas editor-session (localStorage, 同步可用) 历史存在动机即为此: 官方恢复读 storage 时序不可靠
  (git 历史 App.tsx 注释: "容器初始化恢复失败会清空 storage")
- 待排查方向:
  1. storage 读 workbench.json 的实际 HTTP 请求/失败时点 (network: /api/fs/read|stat?path=workbench.json, header=home)
  2. codeblitz storage 后端缓存: getStorage 实例创建时是否一次性加载 + 失败空缓存
  3. 若确为锚点时序 → 让 workbench 恢复在锚点就绪后重试 / 或 doInitialize 前等待 (不改框架前提下评估)

## 8. 相关文件速查

| 文件 | 作用 |
| --- | --- |
| `~/.codeblitz/datas/workbench.json` | tab 持久化文件 (官方 WORKBENCH storage) |
| `node_modules/@opensumi/ide-editor/lib/browser/workbench-editor.service.js` | saveOpenedResourceState / restoreState / EditorGroup.restoreState (恢复 doOpen) |
| `node_modules/@opensumi/ide-editor/lib/browser/grid/grid.service.js` | EditorGrid serialize/deserialize |
| `node_modules/@opensumi/ide-core-common/lib/storage.js` | STORAGE_NAMESPACE.WORKBENCH |
| `node_modules/@codeblitzjs/ide-sumi-core/lib/client/welcome/welcome.contributon.js` | 官方欢迎页打开规则 + WelcomePage 扩展点 |
| `node_modules/@codeblitzjs/ide-sumi-core/lib/common/types.d.ts` | RuntimeConfig.WelcomePage / startupEditor / defaultOpenFile 类型 |
| `sumi/src/config/runtime.ts` | numas WelcomePage 注入点 |
| `sumi/src/extensions/welcome/WelcomeView.tsx` | numas 欢迎 UI (官方容器内渲染) |
| `sumi/src/config/modules.ts` | 模块注册表 (自建 welcome/editor-session 已移除) |
