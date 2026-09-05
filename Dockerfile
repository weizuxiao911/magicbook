# syntax=docker/dockerfile:1.7
# numas (牛马 AI) docker 镜像
#
# 多阶段构建:
#   builder  装 node 20 + bun + ca-certificates + git, 跑 sumi build + opencode build,
#            产出单二进制 dist/opencode-linux-<arch>/bin/opencode (内嵌 sumi 静态资源)
#   runtime  debian:12-slim + ca-certificates + tini + 单一 binary + entrypoint.
#            ENTRYPOINT 启, CMD 透传额外参数给 opencode web
#
# 构建 (见 scripts/build-docker.sh):
#   docker buildx build \
#     --platform linux/amd64 \
#     --build-arg NUMAS_VERSION=$(node -p require('./package.json').version) \
#     --build-arg NUMAS_GIT_SHA=$(git rev-parse --short HEAD) \
#     -t numas:v0.1.0 -t numas:latest -f Dockerfile .
#
# 运行:
#   docker run --rm -p 4096:4096 numas:v0.1.0
#   docker run --rm -p 9000:9000 -e PORT=9000 numas:latest
#   docker run --rm -p 4096:4096 -e REGISTRY=http://host:7790 numas:latest

ARG NODE_MAJOR=20
ARG BUN_VERSION=1.3.14

# =============================================================================
# builder 阶段: 编译 sumi + opencode 单二进制
# =============================================================================
FROM debian:12-slim AS builder

ARG NODE_MAJOR
ARG BUN_VERSION
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# 工具链: ca-certificates(https 下载) + curl + git + xz-utils(bun 安装包用) + gnupg(node apt 源签名) +
#   build-essential + python3 + pkg-config (node-gyp 编译 native modules, 如 tree-sitter-*)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git gnupg unzip xz-utils \
       build-essential python3 pkg-config \
  && rm -rf /var/lib/apt/lists/*

# node 20 (debian 12 默认 18, 升 20)
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && node --version \
  && npm --version

# bun (固定版本; 按 TARGETARCH 装对应二进制, docker TARGETARCH→ bun 文件名映射: amd64=x64, arm64=aarch64)
# 装到 /root/.bun/bun, 同时建 /usr/local/bin/bun 软链 (postinstall 用 'bun' 命令, PATH 任意都能找到)
RUN BUN_ARCH=""; \
    case "${TARGETARCH}" in \
      amd64) BUN_ARCH="x64" ;; \
      arm64) BUN_ARCH="aarch64" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip \
  && unzip /tmp/bun.zip -d /root/.bun \
  && mv "/root/.bun/bun-linux-${BUN_ARCH}/bun" /root/.bun/bun \
  && rmdir "/root/.bun/bun-linux-${BUN_ARCH}" \
  && rm /tmp/bun.zip \
  && ln -sf /root/.bun/bun /usr/local/bin/bun \
  && /root/.bun/bun --version

WORKDIR /build

# 1) 先 copy 依赖清单 + 锁 (cache layer: 源码未变则跳过 install)
COPY package.json package-lock.json* ./
COPY sumi/package.json sumi/package-lock.json* ./sumi/
COPY opencode/package.json opencode/bun.lockb* ./opencode/
COPY opencode/packages/opencode/package.json opencode/packages/opencode/bun.lockb* ./opencode/packages/opencode/
COPY opencode/packages/app/package.json ./opencode/packages/app/

# 2) 再 copy 全部源码
COPY . .

# 3) sumi install (跟 dev.js 一致: --ignore-scripts 跳过 postinstall)
WORKDIR /build/sumi
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org
# retry 3 次
RUN for i in 1 2 3; do \
      npm install --ignore-scripts --no-audit --no-fund && break; \
      echo "[numas] npm install retry $i failed, retrying..."; \
      sleep 5; \
    done

# 4) sumi build (webpack)
RUN npm run build

# 5) opencode install (跨平台 native binding --os="*" --cpu="*")
# 注: opencode 产物名 = "opencode-<os>-<arch>"; linux-{arm64,x64}
# 用 --ignore-scripts 跳过 native module 编译 (tree-sitter / node-pty 等);
#   这些是 TUI 用, web 模式不需; dev.js 在 mac 上靠 xcode-select 工具链跑通,
#   docker 内不必编译 (单二进制 Bun.build 仍能生成).
WORKDIR /build/opencode/packages/opencode
ENV NUMAS_WEB_DIST=/build/sumi/dist
ENV MODELS_DEV_API_JSON=/build/opencode/packages/opencode/test/tool/fixtures/models-api.json
# 显式走官方 registry, 避免 host 漏带 npm/bun config 注入 npmmirror
ENV BUN_CONFIG_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV BUN_REGISTRY=https://registry.npmjs.org
# 在 opencode/packages/opencode 内写 bunfig.toml (会覆盖父级任何 registry 设置)
# 注: docker build context . 不应修改此文件 (仅为 docker build 用)
RUN printf '[install]\nregistry = "https://registry.npmjs.org"\n' > /build/opencode/packages/opencode/bunfig.toml
# retry 3 次: 沙箱网络不稳, registry.npmjs.org 偶发 ConnectionRefused
RUN for i in 1 2 3; do \
      /root/.bun/bun install --no-save --ignore-scripts && break; \
      echo "[numas] bun install retry $i failed, retrying..."; \
      sleep 5; \
    done

# 6) opencode build (单平台; 容器内 process.platform=linux, process.arch=$TARGETARCH 对应 amd64/arm64)
# build.ts 内部也有 --skip-install 跳过跨平台 native install
RUN /root/.bun/bun run script/build.ts --single --skip-install

# 产物定位: dist/opencode-linux-<TARGETARCH>/bin/opencode
# opencode build.ts 名字映射: arch=arm64 → opencode-linux-arm64; arch=x64/amd64 → opencode-linux-x64
# docker TARGETARCH=amd64 → build.ts process.arch='x64' → 名 = opencode-linux-x64
RUN case "${TARGETARCH}" in \
      amd64) BIN_NAME=opencode-linux-x64 ;; \
      arm64) BIN_NAME=opencode-linux-arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && test -f "dist/${BIN_NAME}/bin/opencode" \
    && mkdir -p /artifacts \
    && cp "dist/${BIN_NAME}/bin/opencode" /artifacts/opencode \
    && /artifacts/opencode --version

# =============================================================================
# runtime 阶段: 极简 final, 仅 binary + runtime deps + entrypoint
# =============================================================================
FROM debian:12-slim AS runtime

ARG NODE_MAJOR=20
ARG NUMAS_VERSION=0.0.0
ARG NUMAS_GIT_SHA=unknown

LABEL org.opencontainers.image.title="numas" \
      org.opencontainers.image.description="Numas (牛马 AI) — 打工人首选工作模式" \
      org.opencontainers.image.version="${NUMAS_VERSION}" \
      org.opencontainers.image.revision="${NUMAS_GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/weizuxiao911/numas" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="weizuxiao911" \
      maintainer="Numas <numas@local>"

# 运行时依赖: ca-certificates (https 出口) + tini (PID 1 信号转发) +
#   全量开发工具 (node/python/git/curl/jq/shell/editor/htop/tmux/build 工具)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tini \
       # shell
       bash zsh \
       # 编辑器 / 监控
       vim nano htop tmux less file \
       # 网络 / 工具
       curl wget jq \
       # 版本控制
       git \
       # python (含 pip / venv / dev headers; debian 无 python-is-python3 包,
       #   alias 由 RUN ln -sf 后面建 /usr/local/bin/python)
       python3 python3-pip python3-venv python3-dev \
       # C/C++ 编译工具 (给用户装 python 包 / 编译 native 模块)
       build-essential pkg-config \
       # sqlite: CLI 工具 + 运行时库 (opencode 用 bun:sqlite 已静态链接, 这里给用户提供 CLI 调 db)
       sqlite3 libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/*

# node ${NODE_MAJOR} (与 builder 一致; bookworm 默认 18, 升 20)
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && node --version \
  && npm --version \
  && python3 --version \
  && python --version

RUN useradd --system --uid 1000 --home /home/numas --shell /bin/bash --create-home numas

WORKDIR /workspace

# 单一 binary (builder 已 build 出当前 TARGETARCH 对应产物)
COPY --from=builder /artifacts/opencode /app/opencode
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && chown -R numas:numas /workspace

ENV NUMAS_HOST=0.0.0.0
ENV NUMAS_PORT=4096
ENV NUMAS_REGISTRY=

EXPOSE 4096

USER numas

# ENTRYPOINT 启 entrypoint; CMD 留空 (用户用 -e NUMAS_PORT/REGISTRY/WEB_UI/... 配参)
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD []
