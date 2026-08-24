# AGENTS.md — servers 子工程

> 服务端：3 套协议标准的服务端实现。继承上级 [`../AGENTS.md`](../AGENTS.md)。

## 职责

| 目录 | 对应协议 | 职责 |
| --- | --- | --- |
| `agent/` | assistant 协议 | 按请求提供 AI 服务；简单实现即为每个用户创建 `opencode serve`，全量代理转发接口请求 |
| `registry/` | registry 协议 | 维护 opensumi 兼容的 VSCode 拓展标准，开发 vsix 拓展，实现 opensumi 的 ext-host 协议服务器（vsix 分发 / 元数据） |
| `fss/` | filesystem 协议 | 文件系统服务器端，提供完整的文件系统 API 接口（读写 / 监听 / pty） |

## 约定 / 禁忌

- 单一职责：每套协议只做一件事，不跨协议堆逻辑。
- 跨层只通过协议标准交互，不直连客户端内部。
- 配置外置：`PORT` / `REGISTRY_BASE_URL` / `OPENCODE_BASE_URL` / `FS_BASE_URL` 等抽成配置，不硬编码。
- 敏感信息不入库。
- 中文优先。

## 验证清单

```bash
cd servers
npm run dev            # 三套协议服务启动
# 各协议接口可通
```

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 初始化子工程文档骨架 | 整个 servers |
