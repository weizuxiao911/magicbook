# AGENTS.md — registry 子服务

> vsix 拓展分发服务（:7781，HTTPS，kt-ext 协议）。独立于 sandbox 服务运行。继承上级 [`../AGENTS.md`](../AGENTS.md)。

## 职责

vsix 统一管理与分发（参考已验证的 animbook/registry 方案）：

| 步骤 | 说明 |
| --- | --- |
| `vsix/` 放打包的 .vsix | 由 `server/extensions/<name>/` 源码打包（`npx @vscode/vsce package`） |
| `npm run build` | 扫描 vsix/ → 解压到 dist/<id>/（extension/ 平铺）→ 生成 `dist/metadata.json`（IExtensionBasicMetadata 完整字段） |
| `npm run serve` | HTTPS 静态服务：`GET /metadata.json` + `GET /<id>/*`（kt-ext 协议资源） |

## 协议

- `metadata.json`：codeblitz `IExtensionBasicMetadata[]`（含 `pkgNlsJSON`/`nlsList`/`webAssets`/`extendConfig`/`mode='local'`/`uri=kt-ext://<host>/<id>`——缺字段 ext host 加载会崩）
- `kt-ext://<host>/<id>`：codeblitz 加载时转 https，直连 registry 静态资源（`/<id>/*`）
- **HTTPS 必须**（kt-ext 强制 https）；自签证书（certs/，gitignore，部署时重新生成）需加入本机钥匙串信任（浏览器加载扩展资源）

## 约定 / 禁忌

- 单一职责：只做 vsix 分发，不参与沙箱/文件系统/AI 运行时。
- 配置外置：`PORT`（默认 7781）/ `PUBLIC_HOST`（默认 localhost:7781）。
- 敏感信息不入库（certs/ 私钥忽略）。
- 中文优先。

## 验证清单

```bash
cd server/registry
npm install
npm run build        # vsix/ → dist/ + metadata.json
npm run serve        # https://localhost:7781
# GET https://localhost:7781/metadata.json
# GET https://localhost:7781/<id>/package.json
```

## 变更日志

| 日期 | 变更 | 影响范围 |
| --- | --- | --- |
| 初始版本 | 从统一 server 拆出独立 registry 服务（vsix 分发） | 整个 registry |
| 当前 | 重构为 animbook 模式：build（扫描 vsix → 解压 dist + metadata.json）+ HTTPS 静态分发（kt-ext 协议）；移除旧的上传/元数据 API | 整个 registry |