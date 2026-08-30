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
