# Docker 产物目录 (~/.numas) 挂载点与扩展注册功能设计与测试用例

> 目标: 把镜像内程序产物从单一 `/root/.numas` 细分为 **exec / ui / extensions / registry** 四个
> 可挂载点, 内置默认产物 (交付即用) + 允许 `-v` volume 覆盖 (升级/替换不重建镜像);
> registry 服务以本地产物单文件形态内置并由 entrypoint 拉起, 扩展 (vsix) 打包产物全链路进镜像。

## 1. 设计说明

### 1.1 整体结构

```
容器 (ubuntu:24.04, USER root, workdir /app)
│
├── /app                      工作区根 (explorer 只见用户文件; 默认 workdir, NUMAS_WORKDIR 可切)
└── /root/.numas/             程序根 (镜像内置默认, 每子目录可被 -v volume 覆盖)
    ├── exec/opencode         opencode 单二进制 (本地产物 COPY, OPENCODE_ARTIFACT 定 arch)
    ├── ui/                   sumi web 静态产物 (entrypoint 默认 --web-ui /root/.numas/ui)
    ├── registry/             registry-server 单文件 (本地产物 bun 编译, 无 node 依赖)
    └── extensions/           registry 数据根 (metadata.json + kt-ext 解包静态, 默认内置)
```

### 1.2 设计原则

- **内置默认 + 可覆盖**: 四个目录镜像内都带默认产物, 开箱即用; 运维 `-v host:/root/.numas/<sub>` 覆盖任一目录即替换对应能力, 不重建镜像
- **零容器内编译**: exec / ui / registry-server / extensions 数据全部由本地产物流程产出, 容器只 COPY + 跑
- **registry 无 node 依赖**: registry-server 用 bun 本地交叉编译为单文件 (与 exec 同构), 容器不再装 node
- **registry 能力**: ① 扫描 .vsix 集合动态生成 metadata + 解包静态分发 (kt-ext 协议), **新增 .vsix 动态可识别** (目录 mtime 失效缓存, 无需重启/重建); ② 加载目录可指定 (`--vsix-dir <path>` / env `VSIX_DIR`, 默认 `/root/.numas/extensions`, 开发环境默认 `registry/vsix`)
- **registry 数据与程序分离**: `extensions/` 是数据 (挂载热更新 .vsix), `registry/` 是程序 (版本随镜像)
- **workdir 与程序根正交**: 工作区根 (/app) 与 ~/.numas 无耦合; 换 workdir 不影响产物加载

### 1.3 核心链路

```
本地产物链 (docker-build.sh, 每步产物缺失自动构建 / --force 强制):
  sumi npm run build                → sumi/dist          → COPY → /root/.numas/ui/
  opencode NUMAS_TARGET 交叉编译     → dist/opencode-*   → COPY → /root/.numas/exec/opencode
  extensions/* 各自打包 .vsix        → registry/vsix/*.vsix  ──COPY──→ /root/.numas/extensions/
  registry bun build --compile     → registry-server     → COPY → /root/.numas/registry/
       (server 内置: 扫描 .vsix → metadata.json + 解包缓存 → 静态分发)

entrypoint.sh 拉起顺序:
  1) cd $WORKDIR (/app)
  2) 起 registry-server (默认 --vsix-dir /root/.numas/extensions, PORT=7790, 监听 127.0.0.1):
       扫描 .vsix 集合 (目录 mtime 失效缓存) → 动态生成 metadata + 解包静态
  3) exec opencode web --web-ui /root/.numas/ui --registry /proxy/7790 ...
     (前端 __APP_CONFIG__.registryBaseUrl=/proxy/7790 → 同源经 opencode /proxy 反代到容器内 7790)

扩展动态添加 (不改镜像/不重启服务):
  1) 新 .vsix 放入挂载目录 (docker run -v host/exts:/root/.numas/extensions)
  2) sumi 重新拉 /metadata.json → 新条目出现 → 前端加载新扩展
  (开发期等价: registry-server --vsix-dir <本地 registry/vsix> 直接跑)
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
- opencode fork `/proxy/<port>` 对容器内 127.0.0.1:7790 的反代行为 (registryBaseUrl 相对路径支持) — 需要读 fork proxy 实现后定 entrypoint 默认参数形态
- registry-server 改造细节: 扫描 .vsix 集合 → metadata + 解包缓存 (吸收现有 src/build.js 能力); 目录 mtime 失效缓存粒度; bun build --compile 兼容性 (`__dirname` 硬编码 → env/参数)
- 前端"动态添加"刷新粒度: sumi extension.service 重新拉 metadata 即可识别 (页面级刷新 or 轮询重拉), 是否做自动热加载另行评估

## 4. 改造清单
- registry: 重写/扩展 server.js → 单文件 registry-server:
  - CLI/env: `--vsix-dir <path>` (默认 /root/.numas/extensions, dev 默认 registry/vsix), `PORT`(7790), 可选 certs
  - 能力 1 (动态添加): 请求 metadata / 静态资源时按目录 mtime 失效缓存, 新增 .vsix 自动入 metadata + 解包缓存
  - 能力 2 (指定目录): --vsix-dir 参数化, 目录即 .vsix 集合 (与工程 registry/vsix 同构)
  - 兼容 bun build --compile: 路径全部 env/argv, 不依赖 __dirname 布局
- 本地产物链 (docker-build.sh): extensions 打包 step (缺失/--force 时跑各扩展打包到 registry/vsix) + registry-server 单文件编译 step
- Dockerfile: /root/.numas 四子目录 + COPY 产物 (extensions = registry/vsix/*.vsix; registry = registry-server 单文件)
- entrypoint.sh: registry 拉起段 (--vsix-dir 默认 /root/.numas/extensions); --web-ui/--registry 默认指向新路径
- .dockerignore: 白名单放行 registry/vsix + registry/src(编译用) 等所需目录
- 前端: registryBaseUrl 相对路径 (/proxy/7790) 兼容性确认 (extension.service.ts fetch 同源即可)

## 5. 执行记录
| 用例 | 结果 | 备注 |
| --- | --- | --- |
