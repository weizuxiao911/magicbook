# PDF 标注功能 — 设计 + 实现记录

> PDF reader (`web/src/extensions/pdf/`) 标注功能的设计 + 实时实施状态.
> 本文档**实时更新**, 每次功能/设计调整都同步写入.
>
> 维护约定: 跟 AGENTS.md 一致, 任何设计/实现变更都更新本文件, 重大决策走"决策日志"段.

---

## 1. 目标

PDF 阅读器 (PdfReaderView) 当前**只读 PDF 内嵌 annotation** (pdf.js `getAnnotations()`).
一般电子书/技术书都没有内嵌 annotation, 视觉上"无标注功能".

**目标**: 用户能在 PDF 上**画矩形 + 设置 + 持久化标注**, 跟主流 PDF 阅读器 (Adobe / PDF Expert / MarginNote) 基础体验对标.

---

## 2. 核心概念 (重要: 区分三个易混的维度)

| 维度 | 含义 | 例子 | 阶段 |
|---|---|---|---|
| **交互能力** (interactions / file) | 标注**能做什么** | 批注(comment) / AI讲解(prompt) / 打开文件(file) | **一期 (本文档)** — 后续会持续拓展 |
| **交互执行方式** (PdfAnnotMeta.action) | 标注**怎么执行** (仅 PDF 内嵌 annotation 用) | `[modal:title] 内容` / `[tab:title] 内容` / `[terminal] cmd` | **一期 (内嵌走老路径)** — sidecar 一期暂不绑定执行方式 |
| **视觉样式** | 标注长什么样 | 半透明矩形 + 颜色 (color) + hover 加深 | **一期 (统一高亮)** |

> **2026-08-30 纠偏 (本节核心)**:
> 早期 AI POC 时定义了 `type: highlight | note` 作为"标注类型", 实际只是视觉分类, 跟"交互能力"是不同维度却被混在一起, popover 让用户选"高亮/便签"完全是 AI 自作主张.
>
> **清理结果**:
> - 删 `SidecarAnnot.type` 字段, 全部统一为高亮矩形 (color 决定颜色)
> - popover 不再有"高亮/便签"切换, 顶部只显示"第 N 页 / 编辑标注"
> - 读盘时静默 strip `type` 字段 (不入 in-memory), 写盘时自动不带, 现有 type 在下次重写时自然消失
> - 文档所有"标注类型"措辞统一改为"交互能力"或"视觉样式", 避免再被混淆
>
> **概念边界 (强约束)**:
> - "交互能力" = 标注做什么 (comment/prompt/file), 跟"颜色 / 区域"是不同维度, 一期不绑死, 用户后续会按需加
> - "交互执行方式" = 点击时怎么运行 (modal/tab/terminal), 仅内嵌 annotation 用 contents 约定
> - "视觉样式" = 颜色/hover 效果, 全部统一 (不再分"高亮型/便签型")
> - 一期不做的事, **坚决不加** (跟 §2 早期纠偏记录同源)

---

## 3. 数据结构

### 3.1 存储位置 (sidecar JSON)

- **文件名**: `.{pdfBasename}.annotation` (e.g. `数据结构.pdf` → `.数据结构.pdf.annotation`)
- **位置**: PDF 同目录
- **IDE 相对路径**: `/.{basename}.annotation` (前导 dot, OS 视为隐藏, 仍可读)
- **路径转换**: `sidecarPathFromResource()` in `PdfReaderView.tsx:104-119`
- **冲突处理**: 不处理 (假定同目录无同名 PDF, OS 天然限制)

### 3.2 Schema v1 (`web/src/extensions/pdf/annotations.ts:198-261`)

```json
{
  "version": 1,
  "items": [
    {
      "id": "a-{base36}-{rand}",       // 客户端生成, 幂等写
      "page": 1,                       // 1-based
      "rect": [x1, y1, x2, y2],        // PDF 原坐标 (左下原点)
      "selectedText": "",              // 圈选文本快照 (后续可作备注默认填充)
      "note": "用户备注",               // 通用备注 (可空)
      "color": [55, 148, 255],         // rgb 0-255, 默认蓝
      "createdAt": "2026-08-29T...",   // ISO

      "interactions": [                // 交互能力 (可多选, 至少 1 个才允许保存; 历史: 2026-08-30 起无 type 字段)
        { "type": "comment", "text": "批注内容 (hover 显示)" },
        { "type": "prompt",  "text": "..." }   // AI讲解 (hover 显示"AI讲解"按钮)
      ],
      "file": { "name": "...", "path": "file:///workspace/..." }   // 可选: 关联文件
    }
  ]
}
```

> 注: 上面 `//` 注释是 markdown 展示用, 实际 JSON 不支持. 写盘时通过 `JSON.stringify(file, null, 2)` 不带注释, 字段含义以本表为准.

### 3.3 视觉样式 (一期统一)

| 形态 | 视觉 | 备注 |
|---|---|---|
| **统一高亮** | 矩形热区, 半透明色块叠加 (alpha 0.08 → hover 0.25) + 虚线边框 | color 决定颜色 (8 色可选, 见 AnnotPopover COLORS) |
| **删除按钮** | 右上角 × 圆形按钮 (hover 显示) | 点击直接删除 (in-memory + 写盘过滤) |
| **交互按钮** | 右下角按钮行 (hover 显示), 多个按钮 flex 一行右对齐 | 批注说明→"打开批注"; AI讲解→"AI讲解"; 示例演示→"打开{文件名}" |

> **历史纠偏**: 早期 §3.3 定义了 `highlight` (色块) / `note` (便签图标) 两种视觉, 2026-08-30 清理:
> 1. `type` 字段从 schema 删除, 全部统一为高亮矩形
> 2. 批注/AI讲解/文件三种"交互能力"通过 interactions/file 字段表达, 跟"视觉样式"是不同维度
> 3. 视觉不再分"高亮型/便签型", 仅靠 color + hover 加深区分

> TODO 后续 (按需拓展, 不预先实现):
> - 更多交互能力 (除批注/AI讲解/打开文件外)
> - 自定义颜色 / 调色板 (现 8 色固定)

### 3.4 字段兼容 / 版本升级

- 未知字段忽略 (向前兼容)
- 缺字段用默认值 (`color` 默认蓝, `interactions/file` 可选)
- 旧 `type` 字段: 读时静默 strip (历史 highlight/note, 已弃用), 写时自动不带, 现有 type 在下次重写时消失 (无需迁移)
- 旧 `behavior` 单字段: 读时合并到 `interactions` (保留兼容)
- `version` 字段保留, 后续 schema 升级时校验

---

## 4. 交互设计 (实施)

### 4.1 创建流程 (Rect 矩形选择)

```
1. 用户在 PDF 上 mousedown (左键, 在 .ab-pdf-page 内)
   ↓
2. mousemove 实时画蓝色半透明矩形 (跟随鼠标)
   ↓
3. mouseup → 算 PDF 原坐标 → 弹 popover (右上角)
   ↓
4. popover 内容 (门户到 document.body, z-index 99999, 不被 chat 遮):
   - 标题: "第 N 页" (新建) / "编辑标注" (编辑已有)
   - 选区文本预览 (selectedText 截断显示)
   - 交互能力多选 toggle: 批注 / AI讲解 / 文件 (至少 1 个, 选中显示对应表单)
   - 颜色: 8 色蓝/黄/绿/红/紫/橙/青/粉 (默认蓝)
   - [取消] [保存]
   ↓
5. 矩形蒙层**保留显示** (data-active="1", 蓝色半透明), 提示"这是要标注的区域"
   ↓
6. 点保存 → 校验 (至少 1 个交互) → 写盘 + 渲染为标注热区 + 矩形蒙层移除
   7. 点取消 → 矩形蒙层移除 (不写盘)
```

### 4.2 选区形态 (Rect, 不是文本选择)

**当前选型**: Rect 矩形选择 (mousedown/move/up 画矩形). **不是** 浏览器原生文本选择 (text layer + window.getSelection).

**为什么改**: 文本选择 (text layer 启用) 实际用起来**视觉不直观** — text layer 文字接近透明 (alpha 0.005) 让 canvas 文字透过来, 但浏览器 selection 高亮**被 PDF canvas 遮挡**, 用户看不到选区反馈. 改用 rect 矩形后, 矩形蒙层明显可见.

> TODO 后续: 是否保留 text layer 备用 (后续可能支持"选区内容识别" 等).

### 4.3 标注渲染 (热区)

- **内嵌 (embedded) annotation** (PDF 自带, 有 action): 渲染**带** hover tip + click 触发 modal/tab/terminal
- **sidecar annotation** (外部 JSON, 一期无 action): 渲染**不带** hover tip + 不响应 click. 只视觉高亮 (alpha 0.08 → hover 0.25 + 边框加深)

> **设计纪律** (AGENTS.md 强化): 一期不做的事, **坚决不加**. 之前 AI 自作主张给 sidecar 加 `showAnnotTip` 弹"已批注", 用户**明确禁止** → 拆开渲染路径, sidecar 只视觉高亮.

### 4.4 跨页

一期**不支持** (mouseup 跨不同 page 静默忽略 + warn).

### 4.5 矩形蒙层

- `position: fixed`, z-index 50 (PDF canvas 之上, popover 之下)
- 蓝色半透明 (rgba 55,148,255, 0.18) + 边框 (rgba 55,148,255, 0.9)
- 弹窗时保留 (`data-active="1"`), 提示"这是要标注的区域"
- 保存/取消时移除

### 4.6 popover 位置

- 弹在**矩形右上角下方** (PAD=8px)
- 边界修正: 视口右/底出屏时调整
- **portal 到 document.body**, z-index 99999 — 之前固定在 PdfReaderView 内被 chat panel 遮挡 (pointer-events 拦截)
- popover state x/y = 矩形右上角 clientX/Y

---

## 5. 持久化

### 5.1 写盘策略

- **API**: `__APP_FS__.write(idePath, jsonString)` (走 PTY 单例, 自动 mkdir 父目录)
- **路径**: `sidecarPathFromResource()` 返回的 IDE 相对路径
- **流程**: read-merge-write (读已有 → 合并新 → 写回)
- **Debounce**: 500ms (连续编辑合并一次写)
- **自写去重**: 写盘前算 contentHash, 监听 `fs:changed` 时 hash 对比, 相同跳过 reload
- **失败处理**: 抛错给上层, 上层 toast + 保留 in-memory 状态 + 标"未保存"红点

### 5.2 读盘策略

- **API**: `__APP_FS__.read(idePath)` (走 SDK, 返 `Uint8Array`)
- **时机**: PDF 加载完后, 异步读 sidecar, 解析, 触发 rebuild
- **容错**: 文件不存在 (404) 静默忽略 (第一次打开); JSON 解析失败 console.warn + 用空 items
- **缺失字段**: `parseSidecarAnnot` 单条容错, 返回 null 跳过

### 5.3 外部修改同步 (fs watcher)

- **API**: `window.addEventListener('fs:changed', handler)`
- **过滤**: `detail.path === sidecarPath` 才响应
- **去重**: 跟自写同 hash 跳过 (避免自写触发自 reload)
- **不需自己启 watcher**: 已有 PTY `node:fs.watch` recursive + opencode SSE 双层基础设施 (`web/src/service/fs.ts:239-550, 712-756`)

### 5.4 explorer 可见性

- 一期不设置隐藏: sidecar 文件名 `.{...}.annotation` 已带前导 dot, OS 视为隐藏. opencode tab 跟踪会显示, 但资源管理器默认隐藏 (用户拍板: 不处理 explorer)

---

## 6. 技术架构

### 6.1 涉及文件

| 文件 | 状态 | 职责 |
|---|---|---|
| `web/src/extensions/pdf/annotations.ts` | 已加 | `SidecarAnnot` 类型 + `parseSidecarFile` + `sidecarToAnnotMeta` |
| `web/src/extensions/pdf/sidecar.ts` | 已加 (新) | `readSidecar` / `SidecarWriter` (read-merge-write + debounce + 自写去重) / `contentHash` |
| `web/src/extensions/pdf/AnnotPopover.tsx` | 已加 (新) | popover (类型/颜色/保存/取消, portal 到 body) |
| `web/src/extensions/pdf/PdfReaderView.tsx` | 集成 | 读 sidecar + Rect 选择 + 文本合并渲染 + popover + 写盘 + 文本层 (备用) |

### 6.2 数据流

```
[mousedown/move/up] → 画矩形蒙层
   ↓
[mouseup] → 算 PDF 原坐标 (pdf.getPage + viewport)
   ↓
[setPopoverState] → 弹 popover (portal 到 body)
   ↓
[点保存]
   ↓
[handlePopoverSave] → sidecarWriter.push([annot]) (debounce 500ms)
   ↓
[SidecarWriter.flush] → readSidecar + merge + write
   ↓
[__APP_FS__.write] → 真实写盘
   ↓
[fs:changed CustomEvent] → 自写去重 (hash 对比)
   ↓
[rebuildViewer] (setSidecarTick +1) → 渲染新热区
   ↓
[ab-pdf-annot-layer] 渲染为视觉高亮 (sidecar 模式, 不带 tip/click)
```

### 6.3 复用现有能力

- **fs 读写**: `__APP_FS__.read/write` (`web/src/service/fs.ts`)
- **fs 监听**: `window.addEventListener('fs:changed', ...)` (`web/src/service/fs.ts:749`)
- **PDF 坐标换算**: 现有 PdfReaderView 热区渲染已实现, 复用 scaleX/scaleY
- **text layer**: 已启用 (`web/src/extensions/pdf/PdfReaderView.tsx:487-508`), 但当前未用于选择 (改 rect 方案后备用)

---

## 7. 实施状态

### 7.1 已完成 (一期 MVP)

- [x] sidecar JSON schema 定义 (无 type 字段, 2026-08-30 起统一高亮)
- [x] 读盘: `__APP_FS__.read` + 容错 + strip 旧 type 字段
- [x] 写盘: read-merge-write + debounce 500ms + 自写去重 (hash) + 不带 type 字段
- [x] Rect 矩形选择 (mousedown/move/up 画蓝色蒙层)
- [x] 鼠标坐标 → PDF 原坐标 (跨页忽略, 5x5 px 最小尺寸过滤)
- [x] 矩形蒙层在弹窗时保留, 保存/取消时移除
- [x] popover (门户到 body, z-index 99999) — 颜色 (8 色) + 交互能力多选 (批注/AI讲解/文件) + 区域预览 + 至少 1 个交互校验 + 保存/取消
- [x] sidecar 标注渲染: 统一高亮 (alpha 0.08 → hover 0.25), 无 tip
- [x] sidecar 标注 hover 显示 X 按钮 (右上角): 点击直接删除 (从 in-memory + 写盘过滤)
- [x] sidecar 标注 hover 显示右下角按钮行: 批注说明→"打开批注" → modal; AI讲解→"AI讲解" → chat.send; 示例演示→"打开{name}" → editor.open
- [x] sidecar 标注 hover 显示批注 tip (合并多条 comment 文本)
- [x] sidecar 标注 dblclick → 弹编辑 popover (覆盖已有 annot, 按 id 幂等)
- [x] 内嵌 annotation 仍走老路径 (hover tip + click action)
- [x] fs:changed 监听, 外部修改自动 reload
- [x] 失败 toast + 红点标记
- [x] end-to-end 验证: 画矩形 → 弹 popover → 保存 → PDF 上看到高亮 → hover 显示批注/按钮/X → 点击删除 → 标注消失 + sidecar 写空 items (type 字段自动 strip)

### 7.2 未做 (待用户拍板)

> **AI 自主做的禁区** (AGENTS.md 强化): 任何"看起来显然"或"用户应该会喜欢"的自作主张都**不做**. 一期没拍板的功能, 后续讨论.

- [ ] **更多交互能力** (除批注/AI讲解/打开文件外, 用户后续按需拓展)
- [ ] **侧栏列表** (按页分组, 跳转/搜索)
- [ ] **备注 textarea** (note 字段编辑器, 现仅 interactions.file 字段触发; 通用 note 字段无独立 UI)
- [ ] **文本选择 (替代/补充 Rect)** (text layer 已启用, 未用于选择)
- [ ] **调色板自定义** (默认 8 色: 蓝/黄/绿/红/紫/橙/青/粉, 一期够)
- [ ] **更多视觉样式** (box / underline / strikeout / text 边框型 — 但 type 字段已删, 仅在交互能力上拓展)
- [ ] **跨页选区** (一期不支持)
- [ ] **撤销** (删除后 5s 内可恢复 — 复杂, 一期不做)
- [ ] **删除确认弹窗** (用户口头说"点 X 删除"未要求确认, 当前**直接删**; 一期不做确认 modal)

---

## 8. 决策日志 (纠偏过程)

| 时间 | 误判 | 正确方向 | 影响 |
|---|---|---|---|
| 早期 | 把 `modal/tab/terminal` 当"标注设置" | 那是"标注运行时行为", 跟"标注设置"是不同维度 | 一期只做标注 CRUD, 行为后续 |
| 早期 | 提"画矩形"圈选 | 用户要"文本拖拉选中" | 改用文本选择 (text layer + getSelection) |
| 早期 | 用"文本选择"实现, 但 text layer 视觉不直观 | 改回 **Rect 矩形选择** (画蓝色蒙层) | 现在实现 |
| 早期 | 文件格式 `{pdf}.annots.json` | 用户定 `.{pdf}.annotation` (无 .json, dot 前缀) | 改路径生成 |
| 2026-08-29 | AI 在 sidecar 标注上**自作主张**挂 `showAnnotTip` 弹"已批注" | 用户**明确禁止**悬停提示"已标注" | 拆开渲染: sidecar 无 tip 只高亮, 强化 AGENTS.md 铁律 |
| 2026-08-29 | popover 固定在 PdfReaderView 内被 chat 遮 | 改用 React Portal 渲染到 document.body, z-index 99999 | 实施 |
| 2026-08-29 | 之前 `setUserScaleIdx` 闭包快照丢 click | 改 functional update `setUserScaleIdx((prev) => ...)` | 修 |
| **2026-08-30** | **AI POC 时定义 `type: highlight \| note` 作为"标注类型"** | **用户明确: 这不是 PDF 交互能力, 是 AI 自作主张; 真实交互能力 = 批注/AI讲解/打开文件, 视觉/交互/执行方式三个维度不能混** | **删 type 字段: 全部统一为高亮矩形 (color 决定颜色); popover 不再有"高亮/便签"切换; 读时 strip, 写时自动不带, 旧 type 在下次重写时自然消失; 文档统一改为"交互能力/交互执行方式/视觉样式"三分** |

---

## 9. 待拍板项 (实施前必走 question)

> 任何"看起来显然"或"用户应该会喜欢"的功能, 都列在这等用户拍板. AI **不**自作主张.

1. **更多交互能力** (除批注/AI讲解/打开文件外, 用户后续按需拓展)
2. **侧栏列表** (按页分组, 跳转/搜索)
3. **备注 textarea** (note 字段编辑器, 通用备注独立 UI)
4. **文本选择 / Rect 二选一** (Rect 一期, 文本后续)
5. **调色板颜色** (默认 8 色够吗, 要加更多?)
6. **跨页选区** (一期支持还是不支持)
7. **更多视觉样式** (box / underline / strikeout / text 边框型 — 但 type 字段已删, 仅在交互能力维度上考虑)
8. **删除撤销** (5s 内可恢复, 复杂)
9. **删除确认弹窗** (直接删 vs 弹确认 modal)

---

## 10. 参考

- 设计文档历史: 早期版本走"文本选择", 现已改"Rect 矩形选择" (本文件 §4.2 记录)
- AGENTS.md: 项目级 AI 协作铁律, 强约束功能设计必须由用户拍板
- `web/src/extensions/pdf/annotations.ts:166-225`: `SidecarAnnot` 类型 + `parseSidecarAnnot` + `sidecarToAnnotMeta`
- `web/src/extensions/pdf/sidecar.ts`: 读/写/merge 工具 (新文件)
- `web/src/extensions/pdf/AnnotPopover.tsx`: popover 组件 (新文件)
- `web/src/extensions/pdf/PdfReaderView.tsx:487-595`: 合并渲染 (内嵌 + sidecar 分路径)
- `web/src/extensions/pdf/PdfReaderView.tsx:740-857`: Rect 选择 + popover 触发
- `web/src/extensions/pdf/PdfReaderView.tsx:686-720`: fs:changed 监听 (外部修改同步)
- `web/src/service/fs.ts`: `__APP_FS__` 接口 (read/write/list), fs:changed 派发
