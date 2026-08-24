# AGENTS.md — registry 子服务

> vsix 拓展分发服务（:7781），独立于 sandbox 服务运行。继承上级 [`../AGENTS.md`](../AGENTS.md)。

## 职责

vsix 拓展分发：元数据清单、上传/解压、下载、下架、静态资源分发。

| 端点 | 职责 |
| --- | --- |
| `GET /extension` | vsix 元数据清单（client 启动期拉取） |
| `GET /extension/vsix/:file` | 下载原始 .vsix |
| `POST /extension/vsix` | 上传 vsix（multipart file 字段）→ 入库 + 解压 |
| `DELETE /extension/vsix/:file` | 下架 |
| `GET /extension/dist/:id/*` | 解压产物静态资源（kt-ext 协议） |

存储：`registry/extensions/`（vsix/ dist/ uploads/，gitignore）。

## 约定 / 禁忌

- 单一职责：只做 vsix 分发，不参与沙箱/文件系统/AI 运行时。
- 配置外置：`PORT`（默认 7781）/ `PUBLIC_HOST` / `STORE_DIR` 环境变量。
- 敏感信息不入库。
- 中文优先。

## 验证清单

```bash
cd server/registry
npm install
npm run dev            # :7781
# GET http://localhost:7781/health
```

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 从统一 server 拆出独立 registry 服务（vsix 分发） | 整个 registry |