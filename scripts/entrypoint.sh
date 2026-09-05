#!/bin/sh
# numas docker entrypoint
#
# 由 Dockerfile ENTRYPOINT exec form 调用: /usr/bin/tini -- /usr/local/bin/entrypoint.sh [args]
# args 来自 docker run 命令末尾的额外参数 (若用户传了) — 这些会作为 opencode flag 追加
#
# opencode flag 全部由 docker -e env 映射 (短名 / 长名 任一, 短名优先 = 用户覆盖镜像默认的主通道;
# 镜像 Dockerfile ENV NUMAS_*=默认值, 例: docker run -e PORT=8080 替换默认 4096):
#   HOST          / NUMAS_HOST          → --hostname (默认 0.0.0.0)
#   PORT          / NUMAS_PORT          → --port     (默认 4096)
#   CORS          / NUMAS_CORS          → --cors     (默认 '*')
#   REGISTRY      / NUMAS_REGISTRY      → --registry (默认 /extensions = fork 内置扩展市场)
#   WEB_UI        / NUMAS_WEB_UI        → --web-ui   (默认 /root/.numas/ui, 镜像内拷贝的 sumi 产物)
#   WORKDIR       / NUMAS_WORKDIR       → cd         (默认 /app, 决定 instance dir)
#   SUBCMD        / NUMAS_SUBCMD        → 子命令     (默认 web; 可换 serve/acp/...)
#   EXTENSIONS_DIR / NUMAS_EXTENSIONS_DIR → --extensions-dir (默认 /root/.numas/extensions)
#
# 例:
#   docker run --rm -p 4096:4096 numas:latest
#   docker run --rm -p 4096:4096 -v $(pwd):/app numas:latest
#   docker run --rm -p 9000:9000 -e PORT=9000 numas:latest
#   docker run --rm -p 4096:4096 -e REGISTRY=http://host:7790 numas:latest
#   docker run --rm -p 4096:4096 -e WEB_UI=/ui numas:latest
#   docker run --rm -p 4096:4096 -e SUBCMD=serve numas:latest

set -eu

# 把 docker run 末尾的额外参数 ($*) 保存, 避免后续 set -- 覆盖
ORIG_ARGS="$*"

# 读 env: 短名 (PORT/HOST/CORS/...) 优先 — 用户覆盖镜像默认 (Dockerfile ENV NUMAS_*=默认值)
# 的主通道; 长名 (NUMAS_PORT/...) 次之 (同时传两个时短名生效); 最后落到内置默认.
# 例: 镜像默认 NUMAS_PORT=4096, docker run -e PORT=8080 → 短名优先 → 8080 替换默认.
v() {
  if [ -n "$2" ]; then
    short_val=$(eval "printf '%s' \"\${$2:-}\"")
    if [ -n "$short_val" ]; then printf '%s' "$short_val"; return; fi
  fi
  long_val=$(eval "printf '%s' \"\${$1:-}\"")
  if [ -n "$long_val" ]; then printf '%s' "$long_val"; return; fi
  printf '%s' "$3"
}

HOST=$(v NUMAS_HOST HOST 0.0.0.0)
PORT=$(v NUMAS_PORT PORT 4096)
CORS=$(v NUMAS_CORS CORS '*')
# 扩展市场默认同源内置控制器 /extensions (opencode fork 扫 --extensions-dir);
# 外部自建市场可 -e NUMAS_REGISTRY=https://host:port 覆盖
REGISTRY=$(v NUMAS_REGISTRY REGISTRY /extensions)
# 默认指向镜像内拷贝的 sumi 静态产物 (替换 UI = 本地重 build sumi + 重构建镜像)
WEB_UI=$(v NUMAS_WEB_UI WEB_UI /root/.numas/ui)
# 默认工作目录 = 容器根 /app (workdir 即容器内 workspace 根; NUMAS_WORKDIR 可覆盖)
WORKDIR_VAL=$(v NUMAS_WORKDIR WORKDIR /app)
SUBCMD=$(v NUMAS_SUBCMD SUBCMD web)
# 扩展市场扫描目录 (内置 /extensions 控制器; 与工程 registry/vsix 同构, 动态识别新增 .vsix)
EXTENSIONS_DIR=$(v NUMAS_EXTENSIONS_DIR EXTENSIONS_DIR /root/.numas/extensions)

# 工作目录
cd "$WORKDIR_VAL" || { echo "[numas] cannot cd to $WORKDIR_VAL" >&2; exit 1; }

# 拼 opencode 命令 (binary 在 /root/.numas/exec/opencode; 扩展市场为 fork 内置同源端点,
# 无独立 registry 进程/无端口反代依赖)
set --
set -- /root/.numas/exec/opencode "$SUBCMD" --hostname "$HOST" --port "$PORT" --cors "$CORS"
[ -n "$REGISTRY" ] && set -- "$@" --registry "$REGISTRY"
[ -n "$WEB_UI" ]   && set -- "$@" --web-ui   "$WEB_UI"
[ -n "$EXTENSIONS_DIR" ] && set -- "$@" --extensions-dir "$EXTENSIONS_DIR"

# 透传 docker run 末尾额外参数
if [ -n "$ORIG_ARGS" ]; then
  # shellcheck disable=SC2086
  set -- "$@" $ORIG_ARGS
fi

echo "[numas] starting $*"
exec "$@"
