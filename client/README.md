# client（客户端）

交互层，基于 opensumi/codeblitz 构建。`src/service/` 内置 **3 套标准协议**，与 servers 一一对应：

| 协议 | 对接配置 | 实现方式 |
| --- | --- | --- |
| `registry` 协议 | `REGISTRY_BASE_URL` | 按 opensumi 兼容的 VSCode 拓展标准（vsix 的 ext-host 协议）对接 servers/registry，完成**动态拓展注册** |
| `assistant` 协议 | `OPENCODE_BASE_URL` | 引入 `opencode-ai/sdk` 创建实例，对接 servers/agent，**供全局使用** |
| `filesystem` 协议 | `FS_BASE_URL` | 按 opensumi 文件系统协议创建文件系统管理实例，对接 servers/fss，**供全局使用** |

## 内部结构

```
client/src/
├── core/          # 内核：commands（全局命令注册 + 消息总线）/ config（配置）/ styles（样式）
├── service/       # 3 套协议：接口定义 + 实例创建，提供 core 使用
│   ├── registry/        # registry 协议
│   ├── opencode/        # opencode（assistant）协议
│   └── filesystem/      # filesystem 协议
└── extensions/    # 内置拓展：chat / welcome / login / actions
```

## 开发

```bash
cd client
npm install
npm run dev
```

## 约定

- service 负责三套协议：接口定义 + 实例创建，提供 core 使用。
- commands 提供全局命令注册与消息总线，不定义接口。
- 服务只实现协议客户端与对接外部；拓展只消费能力与渲染，不直连服务端。
- 详细规范见 `AGENTS.md`。
