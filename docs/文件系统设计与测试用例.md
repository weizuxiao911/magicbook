# 文件系统设计与验收标准

## 1. 设计说明

### 1.1 整体设计

- 前端基于 codeblitz 支持的 FS 对接 opencode 的 fs/* 文件系统API，实现 codeblitz 读取宿主机工作目录的文件树结构和具体的文件内容 
- 因为 opencode 提供的 fs/* API 没有写操作，通过 opencode pty/* API 构建写通道，以满足 codeblitz 写操作能够创建目录/文件、写文件和删除目录/文件，要支持递归创建和删除
- 为保证文件系统状态同步和数据一致性，codeblitz 通过 opencode pty 接口创建长连接 和 监听 opencode SSE 事件，当涉及文件系统操作时，但事件同步远程数据，但不重新触发写操作同步远程，避免出现循环写操作

### 1.2 设计原则

- 按照 codeblitz fs 框架实现文件系统功能，通过对 opencode fs、pty等 API 的拓展或适配，以实现 codeblitz 内存文件系统能够与宿主机文件系统打通
- codeblitz fs 作为前端全局的文件系统，提供其他拓展能够通过文件系统读写宿主机上的文件信息（前端主动读写，宿主机更新）
- 支持其他应用或人为在宿主机上直接操作目录/文件，变化实时推送 codeblitz，让其同步更新（宿主机更新，前端被动更新） 

### 1.3 核心链路

**单向传播**：
- 拓展写入 → codeblitz fs → opencode pty → 宿主机
- 宿主机上操作 → opencode pty（watch）→ codeblitz fs → 拓展更新

**核心要点**： codeblitz fs 要判断是拖拓展主动写入还是 watch 通知拓展更新，控制文件写同步单向控制单元，避免写操作死循环

## 2. 验收标准

以下操作均在工作目录（“/Users/weizuxiao/Documents/运营阵地”）内完成验收

### 2.1 explorer 主动读写，宿主机与前端一致

1. explorer 创建目录”111”，宿主机必须同步创建
2. explorer 在目录“111”下创建文件“10.txt“，宿主机必须同步创建
3. explorer 打开“10.txt”，输入内容“123456
n\n\n”，宿主机的“10.txt”必须是“123456
n\n\n”
4. explorer 目录”111”，宿主机的目录”111”必须也删除

### 2.2 直接操作宿主机，监听并同步更新 explorer 和其他拓展

1. 在宿主机上创建目录“222”，explorer 同步创建
2. 在宿主机上的目录“222”下创建“1.txt", explorer 同步创建
3. explorer 打开 ”1.txt“，然后在宿主机上的”222/1.txt“写入"hi"，前端的1.txt 编辑器内容必须同步显示”hi“
4. 在宿主机上删除目录”222“，前端explorer同步删除目录“222”

### 2.3 chat → opencode → 宿主机 → explorer 更新

1. chat 发送“创建chat1.txt”，完成后 explorer 同步创建
2. 前端打开 chat1.txt，chat 发送“chat1.txt写入内容123456”，打开的editor内容区同步显示“123456”
3. chat 发送“删除chat.txt", explorer 同步删除

### 2.4 删除同步与缓存残留 (2026-09-01 修复项)

> 背景: OverlayFS 对"只存在于宿主机"的路径只写墓碑不删 writable; WriteSyncFS InMemory 残留会让
> explorer 显示已删文件; chokidar --polling 对空目录删除无事件. 本组用例验证修复后最终一致.

1. explorer 删除**本会话编辑过**的文件 (InMemory 有残留) → 宿主机必须删除, explorer 必须消失, 宿主机不得出现 `.browserfs_deletedFiles.log`
2. 宿主机删除**本会话编辑过**的文件 → explorer 必须消失 (InMemory 残留被清), 编辑器 tab 标记"已删除"
3. 宿主机创建空目录 → explorer 出现; 宿主机删除该空目录 → explorer 消失 (watchexec 覆盖空目录盲区)
4. 宿主机创建非空目录 (含文件) → explorer 出现; 宿主机 `rm -rf` 删除 → explorer 消失
5. explorer 递归删除目录 (含子目录/文件) → 宿主机必须同步删除

### 2.5 断循环与最终一致性

1. 编辑器保存 → 宿主机内容一致, 且 watcher 不得重复触发 (hash 对比 skip, 无循环写)
2. 宿主机修改已打开文件 → 未 dirty 编辑器自动同步新内容, 且**不得自动写回宿主机** (无循环写)
3. 宿主机删除已打开文件 → 编辑器 tab 不得写回重建 (显示"已删除"即可)

### 2.6 边界场景

1. 中文路径: 创建/编辑/删除"中文目录/中文文件名.md" 双向同步正常
2. 大文件: 编辑器写入 ≥1MB 文件, 宿主机内容一致
3. watcher 崩溃恢复: kill watcher pty 进程 → 自动重试重建, 同步不永久失效

## 3. 执行记录

> 执行日期: 2026-09-01; 环境: dev (opencode 24096 + webpack 7788), watcher = watchexec;
> 执行方式: playwright 操作 explorer/编辑器 + 宿主机 bash 操作对照.

| 用例 | 结果 | 备注 |
| --- | --- | --- |
| 2.1-1 | ✅ | explorer 创建目录 111 → 宿主机同步创建 (fileService.createFolder) |
| 2.1-2 | ✅ | explorer 创建 111/10.txt → 宿主机同步创建 |
| 2.1-3 | ✅ | 编辑器输入保存 → 宿主机内容一致 (尾随换行为 monaco 自身行为, 不影响一致性) |
| 2.1-4 | ✅ | explorer 删除 111 (含文件) → 宿主机同步删除, 无 `.browserfs_deletedFiles.log` 残留 |
| 2.2-1 | ✅ | 宿主机创建 222 → explorer 同步出现 |
| 2.2-2 | ✅ | 宿主机创建 222/1.txt → explorer 同步出现 |
| 2.2-3 | ✅ | 宿主机写入 "hi" → 已打开编辑器自动同步 "hi", 且不自动写回宿主机 |
| 2.2-4 | ✅ | 宿主机删除 222 → explorer 同步消失 (修复目录 hash 对比吞事件后通过) |
| 2.3-1 | ✅ | chat 建 chat1.txt → explorer 同步出现 |
| 2.3-2 | ✅ | chat 改内容 "hello world" → 已打开编辑器实时同步 |
| 2.3-3 | ✅ | chat 删除 chat1.txt → 宿主机删除 + explorer 同步消失 |
| 2.4-1 | ✅ | explorer 删除已编辑文件 (InMemory 残留) → 宿主机删除, 无墓碑残留 |
| 2.4-2 | ✅ | 宿主机删除已编辑文件 → explorer 消失, tab 标记「已删除」 |
| 2.4-3 | ✅ | 空目录创建/删除双向同步 (watchexec 覆盖 chokidar --polling 盲区) |
| 2.4-4 | ✅ | 非空目录 `rm -rf` → explorer 同步消失 |
| 2.4-5 | ✅ | explorer 递归删除 3 层目录 → 宿主机同步删除, 无墓碑残留 |
| 2.5-1 | ✅ | 保存 → 宿主机一致 + watcher hash 对比 skip, 无循环写 |
| 2.5-2 | ✅ | 宿主机改未 dirty 编辑器 → 同步内容, 不自动写回 |
| 2.5-3 | ✅ | 宿主机删已打开文件 → tab 标记「已删除」, 不写回重建 |
| 2.6-1 | ✅ | 中文路径创建/编辑/删除双向同步全部正常 |
| 2.6-2 | ✅ | 1MB 文件编辑器保存 → 宿主机 1048576 字节完整一致 (分块写入 ~10s) |
| 2.6-3 | ✅ | kill watcher pty → 自动重试恢复, 恢复后同步正常 |
