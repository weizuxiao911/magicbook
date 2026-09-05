# numas (牛马 AI) 轻量组装镜像 — 无容器内编译, 本地产物直接 COPY
#
# 产物来源 (本地已构建, 与本仓库 dev 流程一致):
#   sumi web UI:  cd sumi && npm run build            → sumi/dist/        (35MB, 含 framework patch)
#   opencode:     cd opencode/packages/opencode && \
#                 NUMAS_TARGET=linux-arm64 bun run script/build.ts --skip-embed-web-ui
#                                                       → dist/opencode-linux-arm64/bin/opencode
#                 (NUMAS_TARGET 只编单平台; 产物 arch 必须与运行平台一致:
#                  docker desktop mac arm64 → linux-arm64; x86 服务器 → linux-x64)
#
# 运行 (entrypoint 拼参, env 映射见 scripts/entrypoint.sh):
#   docker run --rm -p 4096:4096 numas:latest
#   → opencode web --hostname 0.0.0.0 --port 4096 --cors '*' --web-ui /root/.numas/sumi
#   改端口: -e PORT=8080 改容器内监听, -p 映射需配套: docker run -p 8080:8080 -e PORT=8080 numas:latest
#
# 为什么轻量: 旧版多阶段在容器内 npm/bun install + build (网络依赖, 30+ 分钟/次);
# 本版只做 COPY, 迭代 UI/代码 = 本地重跑对应 build + 重构建镜像 (秒~分钟级).
# --web-ui 固定指向 /root/.numas/sumi, 替换 UI 成本有固定规则.
#
# 构建 (见 scripts/docker-build.sh):
#   bash scripts/docker-build.sh          # 本机默认 arch
#   bash scripts/docker-build.sh --platform linux/arm64|linux/amd64
#   bash scripts/docker-build.sh --push --registry gitlab.grjky.com/new-app/numas

ARG NUMAS_VERSION=0.0.0
ARG NUMAS_GIT_SHA=unknown

FROM ubuntu:24.04

ARG NUMAS_VERSION
ARG NUMAS_GIT_SHA

LABEL org.opencontainers.image.title="numas" \
      org.opencontainers.image.description="Numas (牛马 AI) — 打工人首选工作模式 (轻量组装镜像)" \
      org.opencontainers.image.version="${NUMAS_VERSION}" \
      org.opencontainers.image.revision="${NUMAS_GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/weizuxiao911/numas" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="weizuxiao911" \
      maintainer="Numas <numas@local>"

ENV DEBIAN_FRONTEND=noninteractive

# 运行时依赖: 容器内跑 opencode web + 工作区开发常用工具.
#   ca-certificates/tini = 运行必需; git/curl/wget/jq/python* = 容器内工作区开发 (AI agent 常用).
#   node 不需要 (sumi 前端跑浏览器, opencode binary 自含运行时)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tini \
       # shell
       bash zsh \
       # 编辑器 / 监控
       vim nano htop tmux less file \
       # 网络 / 工具 (lsof: opencode 端口 scan 依赖, 缺失 → /proxy 反代 known-ports 全空)
       curl wget jq lsof netcat-openbsd \
       # 版本控制
       git \
       # python (含 pip / venv)
       python3 python3-pip python3-venv python3-dev \
       # C/C++ 编译工具 (给用户装 python 包 / 编译 native 模块)
       build-essential pkg-config \
       # sqlite: CLI 工具 + 运行时库
       sqlite3 libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3 /usr/local/bin/python

# 按用户拍板: 容器内直接以 root 运行 (ubuntu:24.04 预置 uid 1000 的 ubuntu 用户,
# 与自建服务用户冲突, 不再 useradd)
USER root

# 容器内根 = /app (workdir + 默认工作区根, explorer 只见用户文件);
# 程序目录 ~/.numas (root → /root/.numas, 不进工作区) — 挂载点 (设计文档
# docs/Docker产物目录挂载点与扩展注册功能设计与测试用例.md):
#   exec/        opencode 可执行程序 (含内置 /extensions 扩展市场控制器)
#   ui/          sumi web 静态产物 (entrypoint 默认 --web-ui /root/.numas/ui)
#   extensions/  vsix 扩展包集合 (--extensions-dir 指向, opencode 内置市场扫描; 与工程
#                registry/vsix 同构, 动态识别新增 .vsix)
# 每目录镜像内置默认产物 (交付即用), 运维可 -v volume 覆盖任一目录升级, 不重建镜像.
# 注: 扩展市场由 opencode fork 内置 (/extensions 同源端点), 无独立 registry 进程.
WORKDIR /app
RUN mkdir -p /root/.numas/exec /root/.numas/ui /root/.numas/extensions

# ① exec: opencode 单二进制 — arch 由构建脚本显式传入 (docker-build.sh 传 OPENCODE_ARTIFACT,
#   与 --platform 一一对应: linux/arm64→opencode-linux-arm64, linux/amd64→opencode-linux-x64).
#   禁止用 glob (dist 里可能同时存在多平台产物, 会 COPY 冲突/装错 arch). 构建期 --version
#   冒烟即验证 arch 匹配 (exec format error 会在此暴露).
ARG OPENCODE_ARTIFACT=opencode-linux-arm64
COPY opencode/packages/opencode/dist/${OPENCODE_ARTIFACT}/bin/opencode /root/.numas/exec/opencode
# ② ui: sumi web 静态产物
COPY sumi/dist /root/.numas/ui/
# ③ extensions: 镜像内置空目录 (vsix 不进镜像, 用户拍板 2026-09); 扩展运行时 -v 挂载
#    vsix 目录到 /root/.numas/extensions/ (opencode --extensions-dir 扫描, 空目录返回空正常)

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && chmod +x /root/.numas/exec/opencode \
  && /root/.numas/exec/opencode --version

# 端口/host/registry 默认值 (entrypoint 可见的镜像默认; 用户可用短名 env 覆盖, 如
# -e PORT=8080 替换默认 4096 — entrypoint 读值规则: 短名优先, 长名兜底, 再默认)
ENV NUMAS_HOST=0.0.0.0
ENV NUMAS_PORT=4096
ENV NUMAS_REGISTRY=

EXPOSE 4096

# ENTRYPOINT 启 entrypoint (cd 工作目录 + 拼参 exec opencode); CMD 留空用 env 配参
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD []
