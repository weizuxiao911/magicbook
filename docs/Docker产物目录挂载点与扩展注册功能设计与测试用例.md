# Docker 产物目录 (~/.numas) 挂载点与扩展注册功能设计与测试用例

> 目标: 把镜像内程序产物细分为 **exec / ui / extensions** 挂载点 (内置默认产物 + `-v` 可覆盖);
> 扩展市场由 **opencode fork 内置 /extensions 控制器** 提供 (扫描 vsix 目录, 动态识别),
> 不跑独立 registry 进程、不走端口反代; 扩展 (vsix) 打包产物全链路进镜像.

## 1. 设计说明

### 1.1 整体结构

```
容器 (ubuntu:24.04, USER root, workdir /app)
│
├── /app                      工作区根 (explorer 只见用户文件; 默认 workdir, NUMAS_WORKDIR 可切)
└── /root/.numas/             程序根 (镜像内置默认, 每子目录可被 -v volume 覆盖)
    ├── exec/opencode         opencode 单二进制 (含内置 /extensions 市场控制器; OPENCODE_ARTIFACT 定 arch)
    ├── ui/                   sumi web 静态产物 (entrypoint 默认 --web-ui /root/.numas/ui)
    └── extensions/           vsix 扩展包集合 (--extensions-dir; 与工程 registry/vsix 同构)
```

### 1.2 设计原则

- **内置默认 + 可覆盖**: 各目录镜像内带默认产物, 开箱即用; 运维 `-v host:/root/.numas/<sub>`
  覆盖即替换对应能力, 不重建镜像
- **零容器内编译**: exec / ui / extensions 全部由本地产物流程产出, 容器只 COPY + 跑
- **扩展市场内置 (关键架构决策)**: 独立 registry 服务 (node :7790 + opencode /proxy 反代) 已废弃 —
  脆弱点: 容器需第二进程; /proxy 依赖端口 scan + lsof (容器缺 lsof 全挂); scan 3s 窗口竞态。
  改为 opencode fork 内置 `/extensions` 同源端点 (扫描 .vsix → metadata + 静态分发),
  单进程无竞态; 历史对比见 §1.3
- **extensions 动态添加**: 目录签名 (mtime/size) 失效缓存, 新 .vsix 放入即自动识别
- **workdir 与程序根正交**: 工作区根 (/app) 与 ~/.numas 无耦合

### 1.3 核心链路

```
本地产物链 (docker-build.sh, 每步产物缺失自动构建 / 强制重建 flag):
  step1 sumi build               → sumi/dist         → COPY → ui/
  step2 opencode NUMAS_TARGET 交叉编译 → dist/opencode-linux-<arch> → COPY → exec/ (含 /extensions)
  step3 extensions npm run package → registry/vsix/*.vsix → COPY → extensions/
  step4 docker buildx 组装 (ubuntu 24.04 + COPY + tini entrypoint)

运行 (单进程):
  opencode web --web-ui /root/.numas/ui --registry /extensions --extensions-dir /root/.numas/extensions
    ├─ 前端 registryBaseUrl=/extensions (同源): metadata + 扩展静态资源直出
    ├─ 外部市场资产 (uri 带 authority, 如 alipay CDN 图标) 仍走原 CDN (前端分流)
    └─ 扩展更新: 新 .vsix 放挂载目录, 刷新/重拉 metadata 即识别 (动态)

历史形态对比 (已废弃):
  独立 registry 服务 (:7790) + --registry /proxy/7790 反代
    → 第二进程 + 端口 scan/lsof 依赖 + 3s 窗口竞态 (容器缺 lsof 即全挂)
```

## 2. 验收标准

### 2.1 目录与挂载 (X.1-1 ~ X.1-4)
- X.1-1 镜像构建后容器内存在 `/root/.numas/{exec,ui,extensions,registry}` 且均含默认产物: exec/opencode 可执行、ui/ 含 index.html、extensions/ 含 metadata.json (≥3 条目)、registry/registry-server 可执行
- X.1-2 `docker run -v <host_ui_dist>:/root/.numas/ui` 后页面加载的是 host 版本 (改 index.html 标题可见) — ✅/⏳
- X.1-3 `docker run -v <host_ext>:/root/.numas/extensions` 后前端扩展列表变为 host 内容
- X.1-4 `docker run -v <host_bin>:/root/.numas/exec/opencode` 覆盖 binary 可启动 (冒烟 --version)

### 2.2 registry 服务 (X.2-1 ~ X.2-3)
- X.2-1 entrypoint 自动拉起 registry-server, 容器内 `curl 127.0.0.1:7790/metadata.json` 200 且条目与内置一致
- X.2-2 opencode 启动参数含 `--registry /proxy/7790`; 页面 console 出现扩展 metadata 拉取成功 (3 entries: docxreader/html/paper), 无跨域/404
- X.2-3 容器无 node 进程依赖: 镜像内 `node` 不存在, registry 服务正常运行

### 2.3 extensions 打包产物入链 + 动态添加 (X.3-1 ~ X.3-4)
- X.3-1 干净环境 (registry/vsix、registry/dist 全删) 跑 docker-build.sh, 自动完成 extensions 打包 → .vsix → 镜像内 /root/.numas/extensions 含 3 个 .vsix, metadata 3 条目
- X.3-2 容器内打开 html/paper/pdf 样例文件, 对应自定义编辑器正常渲染 (webview 资源从 /proxy/7790 拉取)
- X.3-3 **动态添加**: 容器运行中向挂载目录放入第 4 个 .vsix (带挂载卷场景), 前端重新拉 /metadata.json 即出现新条目; 加载该扩展可用
- X.3-4 **指定目录**: registry-server 以 `--vsix-dir <其它路径>` 启动 (开发/单测), metadata 内容随指定目录变化

### 2.4 workdir 正交 (X.4-1 ~ X.4-2)
- X.4-1 默认 `docker run` workdir=/app, UI 资源/扩展/registry 均正常 (不依赖 workdir)
- X.4-2 `-e NUMAS_WORKDIR=/workspace` (容器预建) 后同样正常, explorer 根为 /workspace

### 2.5 回归 (X.5-1 ~ X.5-3)
- X.5-1 容器首启 storage 无 mkdir 500 复现 (二次刷新归零), 路径为 /root/.codeblitz
- X.5-2 `/root/.numas` 不出现在 /app explorer 文件树
- X.5-3 `-e PORT=8080` + `-p 8080:8080` 生效

## 3. 待确认/待验证项
- ~~opencode /proxy 反代容器内 registry 行为~~ → 已废弃 (改内置 /extensions, 无反代依赖)
- ~~registry-server bun 编译兼容性~~ → 已废弃 (能力并入 opencode fork)
- 前端"动态添加"刷新粒度: 页面/重新拉 metadata 即识别 (轮询热加载另行评估, 非阻塞)
- 外部市场资产 (带 authority) 分流: 已实现并验证 (图标 CDN 200)

## 4. 改造清单 (完成态)
- opencode fork: `src/server/extensions-route.ts` 内置 /extensions 控制器 (adm-zip 扫 vsix,
  目录签名失效缓存动态识别; metadata uri 不带 authority); `--extensions-dir` 参数;
  `--registry` 默认 `/extensions` 注入前端; `Server.listen`/`createRoutes` 透传
- opencode fork 版本命名: `numas-v<numas根version>-<ts>` (packages/script/src/index.ts)
- sumi: `extension.service.ts` registryBaseUrl 相对路径归一化 + 静态资源 authority 分流
  (本地扩展 → registryBaseUrl, 市场资产 → 原 CDN); webpack 默认 registry `/extensions`
- Dockerfile: 三挂载点 exec/ui/extensions + COPY 产物; runtime 装 lsof (端口 scan 依赖, 保留)
- entrypoint.sh: `--extensions-dir`/`--registry /extensions`/`--web-ui` 默认; 无 registry 进程段
- docker-build.sh: 4 步产物链 (sumi/opencode/extensions vsix/docker); 产物复用 + 强制重建 flag
- 废弃: 独立 registry 服务入镜像 (registry/src/* 保留为 dev/vsix 打包工具, 不再打包/启动)

## 5. 执行记录
| 用例 | 结果 | 备注 |
| --- | --- | --- |
