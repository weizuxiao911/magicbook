# AGENTS.md — Magicbook 项目 AI 协作约定

> AI agent 速查表。修改前先看「项目速写」「分层思想」「约定 / 禁忌」再动手。

## 项目速写

`magicbook` 是 C/S（客户端/服务器）架构可交互工作台，系统分两层：

| 子工程 | 职责 | 协议标准 |
| --- | --- | --- |
| `servers/` | 服务端：3 套协议标准的服务端实现 | agent（assistant）/ registry（registry）/ fss（filesystem） |
| `client/` | 客户端：基于 opensumi/codeblitz 的交互层 | registry / assistant / filesystem |

## 关键文件位置

```
magicbook/
├── package.json          # 顶层编排: dev/build（servers + client）
├── servers/              # 服务端（3 套协议标准实现）
│   ├── agent/            # assistant 协议: opencode serve 服务端
│   ├── registry/         # registry 协议: opensumi ext-host 协议服务器
│   └── fss/              # filesystem 协议: 文件系统 API
├── client/               # 客户端（opensumi/codeblitz）
│   └── webapp/
│       ├── src/
│       │   ├── core/        # 内核: commands / config / styles
│       │   ├── services/    # 3 套标准协议客户端: registry / assistant / filesystem
│       │   └── extensions/  # 拓展: actions / chat
```

## 关键命令

```bash
# 根目录 (magicbook/)
npm install
npm run dev              # servers + client 并发启动
npm run build            # 生产构建
```

## 分层思想

> 系统采用 **C/S 架构**，只分 2 层：servers（服务端）与客户端（webapp/）；跨层只通过 **3 套协议标准**（registry / assistant / filesystem）交互。

- **servers/** = 3 套协议标准的服务端实现（agent/registry/fss）；**协议标准是契约，服务个数只是部署形态**。
- **client/webapp/services/** = 3 套标准协议客户端（registry/assistant/filesystem），与 servers 一一对应。
- 服务端对客户端只暴露 3 个配置：`REGISTRY_BASE_URL` / `OPENCODE_BASE_URL` / `FS_BASE_URL`。
- 内核只定义接口与配置，不承载实现；服务只实现协议客户端与对接外部；拓展只消费能力与渲染，不直连服务端。

## 约定 / 禁忌

- 设计事实源：根目录用户稿图（`系统设计-用户稿图.md`）——命名与分层以稿图为准，不映射任何具体实现现状。
- 跨层只通过 3 套协议标准交互，禁止跨层直连。
- 单一职责：每个模块只做一件事，不跨模块堆逻辑。
- 配置外置：`REGISTRY_BASE_URL` / `OPENCODE_BASE_URL` / `FS_BASE_URL` 等配置抽成独立配置，不散落代码里。
- 敏感信息不入库。
- 中文优先：文档、接口说明、用户可见文案以中文为主。

## 验证清单（改完跑）

```bash
cd magicbook
# servers: 各协议服务可启动、接口可通
# client: tsc --noEmit 通过
```

## 任务执行

按上级 [`../AGENTS.md`](../AGENTS.md) 的「核心决策规则」与「标准工作流程」执行；本文件的项目级约束优先。

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 建立项目骨架：servers/client 两层，按用户稿图设计思想初始化文档 | 整个仓库 |
