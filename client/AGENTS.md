# AGENTS.md — client 子工程

> 客户端：基于 opensumi/codeblitz 的交互层（纯 Web 浏览器运行时）。继承上级 [`../AGENTS.md`](../AGENTS.md)。

## 铁律

1. **client 是纯 Web（浏览器）运行时项目**：不得依赖 Node 运行时。`src/` 代码禁止引用 `process`、`require`、`node:*` 模块，禁止任何 Node polyfill（`path-browserify`、`node-polyfill-webpack-plugin` 等）。配置注入一律走编译期 DefinePlugin 全局常量（如 `__APP_BASE_URL__`），`webpack.config.ts` 属于构建脚本（运行于 node）可例外，但产物不得含 process/node 引用。
2. **接口定义全部在 `core/commands/`**（全局协议/接口/Token + 事件，DI 思想），`service/` 只做实现（implements 对应接口），使用方 `useInjectable(Token)` 注入，不直接 import service 实现。
3. **前端只配置 `APP_BASE_URL`**（统一 server 入口）；其余协议地址（agent/fs/registry）由 server 返回的**完整 URL** 驱动，经 `applyRuntime` 设置，不拼不猜。

## 职责

`src/` 结构：

```
core/commands/     # 全局接口定义层: IAgent / IRegistry / ISandbox / IFileSystem / IEnvService (+Token+事件)
core/config/       # 配置（布局 / 槽位 / 喜好 / 模块 / 运行时 / 品牌）
core/styles/       # 样式覆盖
service/           # 协议实现层: sandbox / agent / registry / filesystem / env（implements core/commands 接口）
extensions/        # 内置拓展: chat / welcome / login / actions
```

## 分层限界

- **core/commands/**：全局接口/协议/Token/事件定义（内核），所有 service 实现的契约。
- **service/**：实现 core/commands 接口，对接 server API，DI 注册 Token。
- **core/config/**、**core/styles/**：配置与样式。
- **extensions/**：内置拓展，经 `useInjectable(Token)` 消费 service 能力，只消费与渲染，不直连服务端。

## 约定 / 禁忌

- 纯前端铁律（见上）。
- 接口在 core/commands 定义、service 实现；commands 不直接定义业务接口之外的实现。
- 配置外置：只配 `APP_BASE_URL`，其余地址由 server 返回。
- 文件系统平台无关：client 永远用 IDE 相对路径（`/foo`），不拼宿主机绝对路径、不解析路径分隔符。
- 敏感信息不入库。
- 中文优先。

## 验证清单

```bash
cd client
npx tsc --noEmit       # 类型检查
npm run dev            # 可访问工作台 (:7788)
# 产物纯净检查（确认无 node 依赖）:
NODE_ENV=production npm run build && rg -l "process\.env|require\(['\"]node:" dist/ || echo "纯前端 ✅"
```

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 初始化子工程文档骨架 | 整个 client |
| 当前 | 规整 src 目录：core（commands/config/styles）/ service（registry/opencode/filesystem）/ extensions（chat/welcome/login/actions）；commands 定为全局命令注册 + 消息总线 | 整个 client |
| 当前 | 铁律固化：client 纯 Web 运行时禁止 Node 依赖；接口定义全部在 core/commands、service 只实现；前端只配 APP_BASE_URL、其余地址由 server 返回 | 整个 client |