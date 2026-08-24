# servers（服务端）

提供服务器端支持，核心是给出**真实可用的服务示例实现**。对应 **3 套协议标准的实现**——关键是协议标准本身，而不是部署成 1 个服务还是 3 个服务。

| 组件 | 对应协议 | 职责 |
| --- | --- | --- |
| `agent/` | assistant 协议 | 按请求提供 AI 服务；简单实现即为每个用户创建 `opencode serve`，全量代理转发接口请求 |
| `registry/` | registry 协议 | 维护 opensumi 兼容的 VSCode 拓展标准，开发 vsix 拓展，实现 opensumi 的 ext-host 协议服务器（vsix 分发 / 元数据） |
| `fss/` | filesystem 协议 | 文件系统服务器端，提供完整的文件系统 API 接口（读写 / 监听 / pty） |

## 开发

```bash
cd servers
npm install
npm run dev
```

## 约定

- 单一职责：每套协议只做一件事，不跨协议堆逻辑。
- 跨层只通过协议标准交互，不直连客户端内部。
- 详细规范见 `AGENTS.md`。
