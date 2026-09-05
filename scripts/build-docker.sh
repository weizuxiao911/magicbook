#!/usr/bin/env bash
# numas (牛马 AI) docker 镜像构建脚本
#
# 用法:
#   bash scripts/build-docker.sh                       # 本机构建 (默认本机 arch)
#   bash scripts/build-docker.sh --push               # 构建并推 dockerhub
#   bash scripts/build-docker.sh --push --registry gitlab.grjky.com/new-app/numas
#   bash scripts/build-docker.sh --platform linux/amd64,linux/arm64 --push
#
# tag 规范:
#   version 取自 package.json (Numas 根): v${version}
#   另打 latest tag
#
# 依赖: docker + buildx

set -euo pipefail

# --- 路径定位 ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- 解析参数 ---------------------------------------------------------------
PUSH=false
PLATFORM=""
REGISTRY="numas"  # 镜像名 (无 namespace); 推 dockerhub 默认走 docker.io/<name>; 推其它 registry 用 --registry xxx/yyy
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)
      PUSH=true
      shift
      ;;
    --platform)
      PLATFORM="$2"
      shift 2
      ;;
    --multi)
      PLATFORM="linux/amd64,linux/arm64"
      shift
      ;;
    --registry)
      REGISTRY="$2"
      shift 2
      ;;
    --no-cache)
      NO_CACHE="--no-cache"
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "[numas] unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

# 默认 platform: 与 buildx 默认 builder 匹配 (linux/amd64 在 x86; linux/arm64 在 arm)
if [ -z "$PLATFORM" ]; then
  case "$(uname -m)" in
    x86_64)  PLATFORM="linux/amd64" ;;
    arm64|aarch64) PLATFORM="linux/arm64" ;;
    *)
      echo "[numas] unsupported host arch: $(uname -m), 需显式 --platform" >&2
      exit 1
      ;;
  esac
fi

# --- 探测 docker / buildx ---------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "[numas] docker 未安装" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "[numas] 需要 docker buildx (Docker Desktop 自带; linux: docker buildx install)" >&2
  exit 1
fi

# --- 解析 version -----------------------------------------------------------
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION_TAG="v${VERSION}"
IMAGE="${REGISTRY}:${VERSION_TAG}"
IMAGE_LATEST="${REGISTRY}:latest"

# 多平台本地 --load 受 buildx 限制, 给出提示
if [ "$PUSH" = "false" ] && [[ "$PLATFORM" == *","* ]]; then
  echo "[numas] 多平台本地构建受 buildx 限制, 多平台需 --push (或拆成单平台逐个 --load)" >&2
  exit 1
fi

echo "[numas] 构建镜像"
echo "[numas]   version:  $VERSION"
echo "[numas]   git:      $GIT_SHA"
echo "[numas]   image:    $IMAGE (also $IMAGE_LATEST)"
echo "[numas]   platform: $PLATFORM"
echo "[numas]   push:     $PUSH"

# --- 构建 -------------------------------------------------------------------
BUILDX_ARGS=(
  buildx build
  --platform "$PLATFORM"
  --build-arg "NUMAS_VERSION=$VERSION"
  --build-arg "NUMAS_GIT_SHA=$GIT_SHA"
  -t "$IMAGE"
  -t "$IMAGE_LATEST"
  -f Dockerfile
)
if [ -n "${NO_CACHE:-}" ]; then
  BUILDX_ARGS+=("$NO_CACHE")
fi
if [ "$PUSH" = "true" ]; then
  BUILDX_ARGS+=(--push)
else
  BUILDX_ARGS+=(--load)
fi
BUILDX_ARGS+=(.)

docker "${BUILDX_ARGS[@]}"

# --- 摘要 -------------------------------------------------------------------
echo ""
echo "[numas] 构建完成"
echo "[numas]   本地: docker run --rm -p 4096:4096 $IMAGE"
echo "[numas]   挂项目目录: docker run --rm -p 4096:4096 -v \"\$(pwd):/workspace\" $IMAGE"
if [ "$PUSH" = "true" ]; then
  echo "[numas]   远程: docker run --rm -p 4096:4096 $IMAGE"
fi
echo "[numas]   改端口: -e PORT=8080 (或 -e NUMAS_PORT=8080)"
echo "[numas]   挂 vsix registry: -e REGISTRY=http://host:7790 (或 -e NUMAS_REGISTRY=...)"
echo "[numas]   切磁盘 UI: -e WEB_UI=/path/to/sumi/dist (或 -e NUMAS_WEB_UI=...)"
echo "[numas]   切子命令: -e SUBCMD=serve (默认 web)"
