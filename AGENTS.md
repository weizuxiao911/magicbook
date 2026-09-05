# AGENTS.md — Numas AI 协作约定

> 用户与 AI 共同维护的项目协作规范. README.md 是给用户看的终态架构,
> docs/AI 工作台总体设计.md 是项目静态事实, 本文件是 AI 协作协议与工程约束.
>
> 品牌: **Numas (🐮 牛马 AI)** — 打工人首选工作模式, 对标腾讯 workbuddy 类产品.

---

## 1. 用户与 AI 协作规范

### 1.1 责任分工

- **用户对结果负责**, AI 辅助完成开发/测试/问题处理等工作.
- **所有功能设计和技术方案必须由用户决策**, AI 仅能根据用户要求展开事实依据调查, 提供建议或方案推荐, **不得替人做决定**.

### 1.2 AI 自主边界 (仅限以下无歧义小动作)

- 拼写/格式/注释修复
- 已约定命名替换
- 单元测试补全
- 只读操作 (跑命令/读日志/截图)
- 临时文件清理 (mv stray 到 `.tmp/`)
- 维护 §4 避坑指南 (沉淀自身经验)

### 1.3 决策点必须用 `question` 工具反馈

适用范围: 技术选型/公开 API/数据模型/config schema 变更、跨模块/跨项目耦合改动、新依赖/新工具/新流程引入、删除/覆盖/迁移/远程写入/重写历史等**不可逆动作**, 以及任何用户未在对话中明确确认的功能/视觉/交互/边界处理.

反馈规范:
- 标题清晰、简洁, 不偏移主题
- 选项至少包含一项**推荐的可执行的、综合价值最高**的 (标"(推荐)")
- 必须由用户拍板, AI 不得用普通文本/隐式同意/"我准备 X 你 OK 吗"等替代

### 1.4 改动必反馈

只要 AI 动过项目文件 (任何改动, 不管多大), 完成后必须用 `question` 工具主动反馈, 询问 git 操作意向. **不得静默结束**.

反馈内容:
- 改了哪些文件 (简短列表)
- 关键改动点 (1-2 句话)

选项必须包含: 提交+推送 (双远程) / 仅提交 / 暂存 / 不 git 操作 (用户拍板).

即使上一轮用户取消了 git 操作选择, 只要 AI 后续又执行了其他改动, 也必须**再次主动反馈**.

### 1.5 Git 流程 (双远程)

任何代码改动后, AI 必须用 `question` 工具反馈改动内容 + 列出提交/推送选项, 由用户决策. AI 不自作主张 `git add` / `git commit` / `git push`.

典型选项: 提交 (1 commit) / 拆 N 个 commit / 不提交; 推 gitlab / 推 github / 两个都推 / 不推; 提交信息 AI 写 / 用户给.

**多远程仓库同步**: 本仓库配置了 2 个远程:
- gitlab: `gitlab.grjky.com/new-app/numas`
- github: `weizuxiao911/numas`

用户拍板"推送"时, **默认两个远程仓库都要推** (gitlab + github), 除非用户明确只推某一个.

推送后自检 `git push` 两个 remote 都执行, 缺一个要补.

> **关键**: 用户对 git 的提示/认可**仅单次有效**. 下一次改动后必须重新提问.

---

## 2. 工程维护约束和规范

### 2.1 接手工作流程

接手工作时**必须以尊重客观事实为前提**, 对现有的功能设计实现和技术框架应用和约束进行全面了解, 再根据任务需求展开讨论和分析, 直到用户决策执行任务才能进行.

过程中如果你觉得满足条件可以进入执行, 可以使用 `question` 工具反馈给用户进行决策; 同理, 如果条件不满足时也可以使用 `question` 工具反馈用户进行选择, 以更好地推进工作落地.

**所有任务不为交付而着急**, 不做 DEMO 级的事. 要么不做, 要么就一次性做好. 做事时必须先充分讨论/分析后完成设计方案, 由用户决策执行才能推进执行. 挖出执行后, 要使用 `question` 工具反馈用户推进下一步操作, 所有的 git 操作必须由用户下达指示或你提问后得到用户认可后才能执行, **记住提示或认可仅单次有效!**

### 2.2 分层架构铁律

> **所有拓展文件系统操作必须通过 codeblitz 的文件系统和 opencode 访问服务器端, 不得直连 service.**

分层 (单向, 外层调内层, 内层不调外层):

```
外部  →  service  →  commands  →  codeblitz  →  extensions
```

- `extensions/` (`sumi/src/extensions/*`) 读写文件: 必须走 codeblitz (`@opensumi/ide-file-service` 的 `IFileServiceClient`) → opencode server fs API (`/api/fs/*`)
- **严禁** extensions 直接调用 service 层的 `__APP_FS__` / `service/fs.ts` 的任何方法
- service 层是 commands / codeblitz / 其他 service 调用的基础设施, 不暴露给 extensions 直调
- commands 层定义对外 API / token / interface, 是 service 与 codeblitz 之间的契约

### 2.3 跨平台路径铁律

> **路径以 opencode 服务端真实路径为单一事实源. 禁止自行拼接/重写/添加前导 `/`. 任何路径处理走 `sumi/src/infra/path.ts` 工具函数, 不要直接写正则/字符串拼接.**

**事实**: codeblitz 暴露的 `idePath` 与 opencode 宿主机 `hostPath` **完全一致**, 仅多 `file://` 协议头 (codeblitz editor 用). 不存在中间虚拟化映射. AI 不得发明 `path.win32` / `path.posix` 转换 / 自定义"虚拟根"层.

**禁令**:
- **禁止硬编码前导 `/`**: `'/' + segments.join('/')` 会让 Windows drive 渲染成 `/D:/projects` 多余前缀 (历史 bug: `extensions/filepicker/FilePicker.tsx:232`). 正确做法: 按首段是否含 `:` 判断, Windows drive 直接作为根 (`D:` / `D:/projects`), POSIX 才补前导 `/`
- **禁止硬编码分隔符**: 跨平台统一用 `/`, 用 `normalizeSep()` (`\\` → `/`). 服务端协议 / UI 展示均 POSIX 分隔
- **禁止写死的 `isWindowsDrive` / `path.win32` 判断到处散落**: 集中用 `infra/path.ts`:
  - `normalizeCwdPath(p)`: Windows drive 去前导 `/` + 去尾 `/` (server `path.win32` 处理)
  - `normalizeSep(p)`: `\\` → `/`
  - `isWindowsDrive(p)`: 单一权威检测
  - `absToRel(abs, ws)`: 宿主机绝对路径 → workspace 相对路径
  - `toHostPath(idePath, anchors)`: codeblitz 虚拟路径 → opencode 宿主路径 (来自 `infra/path.ts:toHostPath`, 不自造)
- **禁止 `/D:/...` 形态直接传给 server**: 走 `normalizeCwdPath` 规范化. 否则 server `path.win32` 按 POSIX 根解析 → 500/错目录
- **HTTP header 路径走 `encodeURI` (浏览器 fetch 强制要求)**: `x-opencode-directory` header 值必须 ISO-8859-1 (Latin-1), 客户端**必须** `encodeURI` 后再发 (中文/非 ASCII 路径直发会抛 `String contains non ISO-8859-1 code point`); server 端 `defaultDirectory` 防御性 `decodeURIComponent` 还原. 详细见 §2.4

**正确示例**:
```ts
// 绝对路径拼接 (POSIX '/Users/foo' / Windows 'D:/projects' 都对)
const p = (segments[0]?.includes(':') ? '' : '/') + segments.slice(0, i + 1).join('/');

// 路径规范化
const safe = normalizeCwdPath(userInput);   // 'D:/projects' 而非 '/D:/projects'

// server 请求前: header 走 encodeURI (兼容 fetch ISO-8859-1, 详见 §2.4)
headers: { 'x-opencode-directory': encodeURI(workspace) }

// server 端 defaultDirectory: 取 header 后防御性 decode
const raw = request.headers["x-opencode-directory"]
const dir = raw ? decodeURIComponent(raw) : process.cwd()
```

**检测方法**: 改完路径相关代码, **必须** 在 `dataDir` 是 Windows 路径 (如 `D:/projects`) 时跑一次, 验证:
- 面包屑/foot-path 不出现多余 `/` 前缀
- `getWorkspace()` / `urlWorkspace()` 返回 `D:/projects` 而非 `/D:/projects`
- `fs.listDir('D:/projects')` 200, 不 500
- 中文路径 `测试/中文目录/文件.md` 正常 resolve

### 2.4 opencode 跨进程通信约定

> **请求 opencode 统一使用 header 携带 `x-opencode-directory`. 不支持 header 的旧 V2 端点才用 `?directory=` query 方式.**

**事实**: opencode 服务端 workspace 路由有两套入口, 但 numas 客户端**必须**只走 header 一套:
- **header 入口** (所有 V1 端点 `/pty` `/file` `/path` 等): `x-opencode-directory` 是 workspace 唯一真实路径, server 端 `defaultDirectory(request, url)` 直接取该 header
- **V2 query 入口** (部分 `/api/...` 端点): `?directory=` query 作为 V2 workspace selector (历史兼容, server `selectedV2WorkspaceID` 才读)
- **混合 bug 链** (历史教训): sumi SDK client `v2/client.ts:33-52` 的 request rewrite 把 header 值复制到 query — `pick()` 比较时 `encodeURI(header)` 与 `encodeURIComponent(fallback)` 不一致导致 mismatch, 最终把 encoded header 写进 query, server `defaultDirectory` fallback 到 `process.cwd()` → 客户端 URL 指定 `?directory=Documents` 实际 PTY 跑到 numas 子目录, WS connect 时 query 是 `Documents` (encoded) → server routing 找不到该 session → **WS 404**

**禁令**:
- **禁止 client 把 header 写进 query**: numas fork 的 `@opencode-ai/sdk/v2/client` 的 request rewrite **只保留 header, 不写 `?directory=` query**. 已加 numas 增量 patch (`v2/client.ts` 后续修改需保留该 patch)
- **强制 client 对 header path 做 `encodeURI`**: 浏览器 fetch API 限制 header 值必须 ISO-8859-1, raw path 含中文/非 ASCII 字符直发会 throw `String contains non ISO-8859-1 code point` → 整个 fetch 失败. server 端 `defaultDirectory` 防御性 `decodeURIComponent` 兼容两端. (历史 `client.ts` 写"raw path + server decode"是基于错误前提, 已被 2026-09 实际报错修订)
- **禁止 `WorkspaceRoutingMiddleware` 兜底到 `process.cwd()` 后无声 fallback**: 若 `x-opencode-directory` 缺失或 decode 失败, 应显式报错或 400 (而不是静默用 server 启动 workdir 替代)

**正确示例**:
```ts
// client: 发送请求时 header 用 encodeURI 形态
const ws = normalizeCwdPath(getWorkspace());
fetch(url, { headers: { 'x-opencode-directory': encodeURI(ws) } });

// server: defaultDirectory 取 header 防御性 decode
function defaultDirectory(request, _url) {
  const raw = request.headers["x-opencode-directory"]
  return raw ? decodeURIComponent(raw) : process.cwd()
}
```

**检测方法**: 切换工作空间 (`?directory=/Users/foo/Documents`) 时, **必须**验证:
- `console` log `[opencode] runtime applied: { workspace: '/Users/foo/Documents' }` (而非 `process.cwd()` fallback 值)
- terminal create 出来的 PTY `cwd` 实际是 `/Users/foo/Documents` (而非 server 启动 workdir)
- WS `/pty/<id>/connect?directory=...` 不出现 404 (encoded header 不再泄漏到 query)
- server `/path?directory=...` 响应 `directory` 字段与请求一致

### 2.5 工程约定 / 禁忌

- **直连无代理**: client → opencode 之间不加 HTTP 中间层
- **CJK 路径 encodeURI**: HTTP header 必须 ISO-8859-1, `x-opencode-directory` 需 `encodeURI()`
- **单一事实源**: 端口 / CORS / APP_BASE_URL 由 dev.js 控制, 透 process.env 注入. 不要散落
- **平台兼容**: fs 命令按 host 平台分流 (mac/linux=POSIX, win=PowerShell); shell 走 `/pty/shells` 探测; **路径处理细则见 §2.3 — 所有路径拼接走 `sumi/src/infra/path.ts` 工具函数, 禁止硬编码前导 `/` 与 `\\` 分隔符**
- **单一职责**: 每个模块只做一件事
- **配置外置**: 敏感信息不入库
- **中文优先**: 文档/接口/文案中文为主
- **品牌**: Numas (牛马 AI) — 打工人首选工作模式. 文档/banner 体现这调性
- **临时文件统一放 `.tmp/`** (项目根, 已在 .gitignore): 日志/截图/临时数据/调试产物全部进 `.tmp/`. **禁止**写到 `/tmp/` (散落难追踪) 或项目其他目录 (污染源码). 后台进程 `&> .tmp/<name>.log` 是标准写法
- **AI agent 操作造成的 stray 零容忍** (本规则对上条的强制版本):
  - playwright mcp 截图/落盘 `filename` 一律**绝对路径** `.tmp/<name>.png`
  - 任何 `> file` / `tee file` / 截图工具的输出, 落盘路径必须在 `.tmp/` 下
  - 每次写完一组操作**必须自检** `git status --short` + `ls .tmp/` 确认没有散落到项目根或子目录的 stray 文件
  - 发现 stray 立刻 `mv` 到 `.tmp/` (mv 不算"破坏性操作")

---

## 3. AI 自成长机制规范和约束

> 此部分 AI 自主维护. 接受用户的教导和帮助, 一切以用户意志为准.
> 不得替用户做决策, 只能提供建议或方案推荐!

> **🔔 AI 强制自查 (任务收尾必做, 未沉淀 = 任务未完成)**:
> 每次协作/一轮任务结束时, 在最终汇报前自查以下三项并落实:
>   ① 本次踩过的坑 / 排查教训 → 补 §4.2 避坑指南 (现象 / 复现路径 / 解决方案, 可回归的要标)
>   ② 反复出现的好做法 / 做事模式 → 补 §4.1 实践指南
>   ③ 用户给的纠正 / 隐式偏好 → 补 §3.2
> 反例: 2026-09 docker 会话连踩 7 坑未自主沉淀, 被用户提醒才补 §4 条目 11-17 —
> 违反 §3.1"自主跟进", 沉淀必须主动, 不依赖用户催促.

### 3.1 长期记忆维护

- **自主跟进项目迭代**: 每次协作后, 把沉淀的知识/教训同步到 §4 避坑指南, 避免同类问题多次出错.
- **沉淀自己的做事方法和习惯**: 反复出现的模式可以总结成 §4.1 实践指南的子项.
- **不替用户决策**: §1 已明确, 自成长过程中遇到需要权衡的方向, 用 `question` 反馈.

### 3.2 接受用户教导

- 用户给的纠正/指引, 当轮即时修正.
- 反复出现的同类纠正, 提炼成 §4 避坑指南.
- 用户的隐式偏好 (例如"回答精简", "先看现象再下结论"), 观察到后沉淀.

### 3.3 自维护边界

AI **可以自主**做:
- §4 避坑指南/实践指南的增删改
- §3.2 沉淀长期偏好
- 拼写/格式/链接/目录校对
- `git mv` 与文档类 rename (跨文档引用同步)
- 临时文件清理 (.tmp/ stray)

AI **仍需 `question`**:
- §1/§2 任何规则条款的增删改
- 跨文档重组
- 与项目事实 (§1/§2) 冲突的修改

---

## 4. 实践手册与避坑指南

> AI 自主维护, 用户可随时指出错误或要求补充.

### 4.1 实践指南

#### 1. 如何撰写功能设计与验收标准

模板 (写入 `docs/<功能名>功能设计与测试用例.md`):

```
# <功能名> 功能设计

> 一句话概括设计目标 + 链路入口

## 1. 设计说明
### 1.1 整体结构   (可选 mermaid graph TD)
### 1.2 设计原则   (3-5 条 bullet, 每条一行)
### 1.3 核心链路   (可选 mermaid sequenceDiagram / flowchart)

## 2. 验收标准 (X.X-1, X.X-2...)
每条: 操作 + 期望 + 状态 (✅ 已验证 / ⏳ 待验)

## 3. 执行记录
| 用例 | 结果 | 备注 |
| --- | --- | --- |
```

要点:
- **写"为什么"不写"做了什么"**: 设计原则 + 链路说明目的, 验收写行为
- **验收可执行**: 每条都是可单步验证的具体动作, 避免"功能正常"这种不可验证
- **测试覆盖三类**: 正常路径 / 边界 / 错误/降级
- **跨模块改动必须列影响面**: 列出被影响的拓展/服务/scheme/事件名

#### 2. 如何高效排查定位关键问题

定位流程 (从表象到根因):

1. **看现象**: 截图 / console / network 三件套, 不靠脑补
2. **找最小复现**: 单步操作能复现 vs 时序/条件才复现, 优先前者
3. **二等分定位**: 沿调用链/数据流画边界, 从中间往两端二分 (例: client → proxy → server, 先确认 proxy 在不在, 再深查两端)
4. **怀疑一切**: 文档说的 ≠ 代码做的. 一旦现象与设计不符, 优先相信现象, 去 grep 代码
5. **历史教训**: `git log --all --oneline -- <file>` + `git blame` 看是不是回归. `git log --grep "<关键字>"` 看历史 issue
6. **确认修复方向**: 找根因后再讨论方案, 不在"症状"层面来回修

输出沉淀到避坑指南: 现象 / 复现路径 / 解决方案 / 是否需要回归测试.

#### 3. 如何拆分多轮任务 (推荐做法)

- 一轮 = 一个可独立验证的里程碑 (build + 跑通 +1 个核心场景)
- 每轮开头**回顾上一轮状态**, 结尾**给当前状态摘要** (committed + pushed + 已知遗留)
- 跨轮任务**先 question 确认是否继续**, 不要一气呵成做完多轮

### 4.2 避坑指南

#### 1. opencode 服务端 `WorkspaceRoutingMiddleware` 静默 fallback 到 `process.cwd()`

- **问题描述**: sumi SDK client 的 request rewrite 把 header 值复制到 query (`pick()` 比较 `encodeURI(header)` 与 `encodeURIComponent(fallback)` 不一致导致), server `defaultDirectory` 兜底到 `process.cwd()`, 客户端 URL 指定 `?directory=Documents` 实际 PTY 跑到 numas 子目录, WS connect 时 query 是 `Documents` (encoded) → server routing 找不到该 session → **WS 404**.
- **复现路径**: 工作空间切到非 numas 启动目录 (`?directory=/Users/foo/Documents`), opencode 后端监听非 :24096 端口, 客户端发起 PTY WS connect.
- **解决方案**: numas fork 的 `@opencode-ai/sdk/v2/client` 的 request rewrite **只保留 header, 不写 `?directory=` query**; client 对 header path 做 `encodeURI`; server `defaultDirectory` 防御性 `decodeURIComponent` 兼容. 见 §2.4.

#### 2. 前导 `/` 硬编码让 Windows drive 渲染成 `/D:/projects`

- **问题描述**: `'/' + segments.join('/')` 在 Windows 下给 `D:/projects` 路径加前导 `/`, 变成 `/D:/projects` 多余前缀, server `path.win32` 按 POSIX 根解析 → 500 / 错目录.
- **复现路径**: `dataDir = 'D:/projects'` 时调用 `fs.listDir('D:/projects')`.
- **解决方案**: 按首段是否含 `:` 判断, Windows drive 直接作为根 (`D:` / `D:/projects`), POSIX 才补前导 `/`. 所有路径拼接走 `sumi/src/infra/path.ts` 工具函数. 见 §2.3.

#### 3. 浏览器 fetch header 限制 ISO-8859-1, 中文路径直发抛错

- **问题描述**: HTTP header 值必须 ISO-8859-1 (Latin-1), raw path 含中文/非 ASCII 字符直发会 throw `String contains non ISO-8859-1 code point` → 整个 fetch 失败.
- **复现路径**: `x-opencode-directory: /Users/测试/目录` (未 encodeURI).
- **解决方案**: client **必须** `encodeURI(ws)` 后再发; server `defaultDirectory` 防御性 `decodeURIComponent`. 见 §2.4.

#### 4. AI 操作造成的 stray 文件污染项目根

- **问题描述**: playwright mcp 截图默认相对路径或 `/tmp/`, 散落到项目根或子目录, 污染源码/触发 lint warning.
- **复现路径**: `screenshot({path: 'foo.png'})` 不带目录前缀.
- **解决方案**: 截图/落盘 `filename` 一律**绝对路径** `.tmp/<name>.png`; 任何 `> file` / `tee file` 输出必须在 `.tmp/`; 写完一组操作自检 `git status --short` + `ls .tmp/`; stray 立刻 `mv` 到 `.tmp/`. 见 §2.5.

#### 5. AI 静默 commit / push, 用户失去决策权

- **问题描述**: AI 自作主张 `git add` / `git commit` / `git push`, 违反"用户对结果负责 + 用户对 git 操作拍板"原则.
- **复现路径**: AI 完成功能后默认执行 commit + push 双远程, 不走 question 工具.
- **解决方案**: 任何改动后**必须**用 `question` 工具列出提交/推送选项, 等用户拍板; 用户对 git 的提示/认可仅单次有效, 下次改动重新提问. 见 §1.4/§1.5.

#### 6. question 选项缺推荐, 用户必须自己拍板所有选项

- **问题描述**: AI 用 question 工具但选项无推荐标, 用户失去"综合价值最高"参考, 易选错或来回问.
- **复现路径**: 选项平铺无标, 用户从 4-5 个里盲目选.
- **解决方案**: 选项至少包含一项**推荐的可执行的、综合价值最高**的 (标"(推荐)"); 标题简洁不偏移主题. 见 §1.3.

#### 7. 用户提示/认可被跨任务复用, 误以为已批准新动作

- **问题描述**: 用户在某轮认可"提交+双远程推送", AI 把它带到下一轮的所有改动, 跳过 question.
- **复现路径**: 第二轮改动后 AI 直接 `git push`, 没问.
- **解决方案**: 用户对 git 的提示/认可**仅单次有效**, 每轮改动后重新走 question. 见 §1.5 末尾强调.

#### 8. CLI `chromium --no-sandbox` 启动需要 bundle ESM 路径, 误用 CJS 路径

- **问题描述**: 排查工具 `cli/chromium-sandbox-flag.js` 启动 puppeteer 时 bundle 路径写错 (`./bundle.js` 找不到).
- **复现路径**: `node cli/chromium-sandbox-flag.js`.
- **解决方案**: 用 `path.join(__dirname, '../dist/something.cjs')`, ESM 项目入口指向 `dist/index.cjs`.

#### 9. 端口反代 URL 拼接漏 `replace(/\/+$/, '')`, 双斜杠出错

- **问题描述**: `proxyUrl(port)` 拼接 baseUrl + `/proxy/<port>/` 时, baseUrl 含尾斜杠会导致 `http://localhost:24096//proxy/8000/`.
- **复现路径**: `appBaseUrl()` 返回 `/` 或 `http://localhost:24096/`.
- **解决方案**: 拼接前 `replace(/\/+$/, '')`, 见 `proxyUrl()` 实现.

#### 10. 内置浏览器默认 `<embed>` 渲染 PDF 不可靠 (依赖 Chrome PDF 插件)

- **问题描述**: headless Chrome 无 PDFium, 部分 Chrome flag 禁用 PDF viewer, `<embed src=blob type=application/pdf>` 渲染失败显示空白.
- **复现路径**: 启用 PDF plugin 禁用的 Chrome.
- **解决方案**: 默认 `pdfMode='pdfjs'`, 走 pdf.js + canvas 渲染, 跨环境可靠. worker 从 unpkg/jsdelivr CDN 拉, CSP `worker-src * blob:` 已透传.

#### 11. 代码/patch 改了但运行镜像没重建 → "改了没修复"假象

- **问题描述**: sumi postinstall patch (storage 路径) 与 Dockerfile 已改, 但容器内 binary 仍是旧产物 (marker 为 0), 用户验证仍失败, 误判方案无效.
- **复现路径**: 改 Dockerfile/package.json/patch 后直接跑旧镜像验证.
- **解决方案**: 验证前先确认"运行中产物"确实含改动: docker 镜像用 `docker exec strings /app/... | grep marker`; 本地 dist 用 grep marker; 交叉/重编产物看构建时间戳. 先对产物版本, 再谈方案对错.

#### 12. 改完源码忘了重编产物就验证 → 旧产物报错误导排查

- **问题描述**: 修 opencode 注入链后直接起旧 binary 验证, 反复报 `provideService is not a function`, 误以为修复方向错.
- **复现路径**: 源码改动后, 运行验证用的 binary/dist 是改动前构建的.
- **解决方案**: 改服务端/前端源码后, 验证前必须重新构建对应产物 (记录构建时间/日志尾部 smoke 通过), 或先 `git log`/时间戳确认产物新于源码改动.

#### 13. 项目 fork 的 Effect 是 v4 beta, 标准 API 可能运行时缺失

- **问题描述**: `Layer.provideService` 编译能过 (类型有), 运行时 `b.provideService is not a function` 直接崩.
- **复现路径**: 用标准 Effect v3 API 在 opencode fork (v4 beta) 里 provide context.
- **解决方案**: fork 内新代码先搜同仓用法/避开重 context 注入; 参数直传优先于 context provide; 跑 smoke test 确认运行时 API 存在.

#### 14. ubuntu 镜像预置 uid 1000 用户, useradd 撞 UID

- **问题描述**: Dockerfile `useradd --uid 1000` 在 debian:12-slim 正常, 换 ubuntu:24.04 后 exit 4 "UID 1000 is not unique" (官方镜像预置 ubuntu 用户 uid 1000).
- **复现路径**: 基础镜像 debian → ubuntu 后不检查预置用户直接构建.
- **解决方案**: 换 base 镜像先核对预置用户/包差异 (apt 包可用性实测一次通过); 本项目按用户拍板直接 USER root, 不自建服务用户.

#### 15. 镜像层 ENV 默认值抢占用户 `-e` 覆盖 → "改端口没生效"

- **问题描述**: Dockerfile `ENV NUMAS_PORT=4096` + entrypoint 优先读长名 NUMAS_PORT → `docker run -e PORT=8080` 永远 4096.
- **复现路径**: 镜像留默认 ENV, entrypoint 长名优先.
- **解决方案**: 约定"短名 env (-e PORT) 是用户替换镜像默认的主通道": 读值顺序 短名 → 长名 → 内置默认 (entrypoint v() 已实现); `-e PORT` 与 `-p` 映射必须配套 (8080:8080), 提示文案写明.

#### 16. fork flag 传了但没人消费 → 前端永远用编译期默认 (dev 碰巧掩盖)

- **问题描述**: opencode `--registry` 参数从未 provide 到 UI 注入层 (RegistryConfig 无 provide 点), 前端 registryBaseUrl 恒为 sumi webpack 编译期默认 `http://127.0.0.1:7790`; dev 时浏览器本机恰好跑着 registry 所以"碰巧工作", 容器部署语义反转 (浏览器侧 127.0.0.1 是用户电脑) 才暴露.
- **复现路径**: 注入链无 provide; 验证只看"功能正常"没查运行时注入值.
- **解决方案**: 验证"配置/注入链"要看运行时实际值 (页面 evaluate `window.__APP_CONFIG__.registryBaseUrl`), 不能只凭功能 OK; 容器场景 registry 必须经同源反代 (--registry /proxy/7790), 启动方显式传参, 不写死编译期.

#### 17. "简化"框架适配逻辑丢字段语义 → 资源路由回归 (explorer 图标全 404)

- **问题描述**: 静态资源 provider 的 resolveStaticResource "简化"成一律 `registryBaseUrl + path`, 丢掉原实现的 `uri.authority` 分流语义 → codeblitz 市场资产 (alipay CDN 的 vsicons 图标, uri 自带 authority) 被指到本地 registry → 图标全 404.
- **复现路径**: 改 kt-ext 静态解析后不对比旧 dist 视觉/网络行为.
- **解决方案**: 改动前先理解字段语义 (authority = 外部市场 host, 无 authority = 本地 registry 扩展); 改动后用旧 dist 页面做网络级对照 (图标请求 host), 再下"简化"结论.