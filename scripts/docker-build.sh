#!/usr/bin/env bash
# numas (牛马 AI) docker 轻量镜像一键构建 — 本地产物组装, 无容器内编译
#
# 流程 (5 步, 每步产物存在则跳过):
#   step 1/5: 依赖安装 (sumi npm install 含 postinstall 框架 patch + opencode bun install)
#   step 2/5: sumi build                    → sumi/dist           → COPY → ui/
#   step 3/5: opencode 交叉编译 (NUMAS_TARGET) → dist/opencode-linux-<arch> → COPY → exec/
#   step 4/5: extensions npm run package    → registry/vsix/*.vsix → COPY → extensions/
#             (扩展市场 = opencode fork 内置 /extensions 控制器, 扫 extensions/ vsix; 无独立进程)
#   step 5/5: docker buildx 组装 (ubuntu 24.04 + COPY 挂载点产物 + tini entrypoint)
#
# 产物复用: 产物已存在则跳过对应 build (强制重建: --sumi / --opencode / --extensions /
#   --force 全部). 迭代成本: 只改 sumi UI → bash scripts/docker-build.sh --sumi.
#
# 用法:
#   bash scripts/docker-build.sh                  # 默认平台自动探测 + 产物复用
#   bash scripts/docker-build.sh --sumi --opencode  # 强制重编 sumi 与 opencode
#   bash scripts/docker-build.sh --tag numas:test # 自定义 tag (默认 numas:v<version> + latest)
#   bash scripts/docker-build.sh --platform linux/amd64   # 交叉产物需与 platform 匹配 (x64)
#   bash scripts/docker-build.sh --push --registry registry.example.com/numas  # 构建并推远端
#   bash scripts/docker-build.sh --no-cache
#
# 运行:
#   docker run --rm -p 4096:4096 numas:latest
#   → opencode web --extensions-dir /root/.numas/extensions --registry /extensions
#     --web-ui /root/.numas/ui (内置扩展市场, 无独立进程; 见 entrypoint.sh)
#
# 运维部署 (linux x86_64 服务器):
#   1. 前置: docker + buildx; node 20+ / bun (产物缺失时自动构建需要)
#   2. bash scripts/docker-build.sh                 # 本机架构直接 --load 产出 numas:latest
#   3. docker run --rm -p 4096:4096 numas:latest    # 或 docker compose / k8s 拉取部署
#   推送私有 registry: bash scripts/docker-build.sh --push --registry gitlab.grjky.com/new-app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- 解析参数 ---------------------------------------------------------------
PLATFORM=""
EXTRA_TAG=""
FORCE_SUMI=false
FORCE_OPENCODE=false
FORCE_EXT=false
NO_CACHE=""
PUSH=false
REGISTRY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --tag) EXTRA_TAG="$2"; shift 2 ;;
    --sumi) FORCE_SUMI=true; shift ;;
    --opencode) FORCE_OPENCODE=true; shift ;;
    --extensions) FORCE_EXT=true; shift ;;
    --force) FORCE_SUMI=true; FORCE_OPENCODE=true; FORCE_EXT=true; shift ;;
    --push) PUSH=true; shift ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help)
      sed -n '2,31p' "$0"
      exit 0
      ;;
    *)
      echo "[numas] unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

# --- platform ↔ opencode arch --------------------------------------------------
NATIVE_ARCH="$(uname -m)"
case "$NATIVE_ARCH" in
  x86_64) NATIVE_PLATFORM="linux/amd64" ;;
  arm64|aarch64) NATIVE_PLATFORM="linux/arm64" ;;
  *) NATIVE_PLATFORM="" ;;
esac
if [ -z "$PLATFORM" ]; then
  [ -n "$NATIVE_PLATFORM" ] || { echo "[numas] unsupported host arch: $NATIVE_ARCH, 需显式 --platform" >&2; exit 1; }
  PLATFORM="$NATIVE_PLATFORM"
fi
case "$PLATFORM" in
  linux/arm64) TARGET_ARCH=arm64; TARGET_NAME=linux-arm64 ;;
  linux/amd64) TARGET_ARCH=x64;   TARGET_NAME=linux-x64 ;;
  *) echo "[numas] 仅支持 linux/arm64 或 linux/amd64" >&2; exit 1 ;;
esac
# buildx --load 只能加载与本机同 arch 镜像; 跨平台必须 --push
if [ "$PLATFORM" != "$NATIVE_PLATFORM" ] && [ "$PUSH" = false ]; then
  echo "[numas] 目标平台 $PLATFORM ≠ 本机 $NATIVE_PLATFORM: buildx --load 不支持跨平台加载" >&2
  echo "[numas] 请加 --push (推到 registry), 或在 $PLATFORM 同架构机器上执行" >&2
  exit 1
fi

# --- 路径 ----------------------------------------------------------------------
SUMIDIST="$ROOT/sumi/dist"
OPENCODE_PKG="$ROOT/opencode/packages/opencode"
OPENCODE_BIN="$OPENCODE_PKG/dist/opencode-${TARGET_NAME}/bin/opencode"
REGISTRY_PKG="$ROOT/registry"
REGISTRY_VSIX_DIR="$REGISTRY_PKG/vsix"

# --- step 1/5: 依赖安装 (sumi npm + opencode bun workspace) ---------------------
# 全新克隆 / CI 环境必备: sumi 的 postinstall 框架 patch (fixLayout / customeditors /
# storagepath 等, 见 sumi/scripts/patch-*.js) 只在 npm install 时触发, 漏装则补丁丢失;
# opencode 是 bun workspaces (bun.lock + workspaces), 根目录 bun install 装全部包依赖.
# 幂等: 依赖已装时 install 按 lockfile 校验, 秒过. extensions 的 install 在 step 4 内.
echo "[numas] step 1/5: 依赖安装"
echo "[numas]   sumi: npm install (含 postinstall 框架 patch)"
(cd sumi && npm install --no-audit --no-fund)
echo "[numas]   opencode: bun install (workspaces 根)"
(cd opencode && bun install)

# --- step 2/5: sumi build ------------------------------------------------------
if [ "$FORCE_SUMI" = true ] || [ ! -d "$SUMIDIST" ] || [ -z "$(ls -A "$SUMIDIST" 2>/dev/null)" ]; then
  echo "[numas] step 2/5: sumi build"
  (cd sumi && npm run build)
else
  echo "[numas] step 2/5: sumi dist 已存在, 跳过 (改 UI 代码后带 --sumi 强制重建)"
fi

# --- step 3/5: opencode 交叉编译 -------------------------------------------------
# build.ts 每次会 rm 整个 dist (含其它平台产物, 如本机 dev 用的 darwin) → 重建前把
# 非目标平台产物暂移 .tmp, 完成后恢复, 避免交叉构建破坏本机 dev 可用产物.
DARWIN_DIST="$OPENCODE_PKG/dist/opencode-darwin-arm64"
if [ "$FORCE_OPENCODE" = true ] || [ ! -f "$OPENCODE_BIN" ]; then
  echo "[numas] step 3/5: opencode 交叉编译 (NUMAS_TARGET=$TARGET_NAME, 本地产物单平台)"
  TMP_BAK=""
  if [ -d "$DARWIN_DIST" ] && [ "$TARGET_NAME" != "darwin-arm64" ]; then
    TMP_BAK="$ROOT/.tmp/opencode-darwin-arm64.bak"
    rm -rf "$TMP_BAK" && mv "$DARWIN_DIST" "$TMP_BAK"
    echo "[numas]   已暂移本机 darwin-arm64 产物 → .tmp/ (构建后恢复)"
  fi
  (cd "$OPENCODE_PKG" && NUMAS_TARGET="$TARGET_NAME" bun run script/build.ts --skip-embed-web-ui)
  if [ -n "$TMP_BAK" ] && [ -d "$TMP_BAK" ]; then
    mv "$TMP_BAK" "$DARWIN_DIST"
    echo "[numas]   darwin-arm64 产物已恢复"
  fi
else
  echo "[numas] step 3/5: opencode ${TARGET_NAME} 产物已存在, 跳过 (改 opencode 代码后带 --opencode 强制重建)"
fi
[ -f "$OPENCODE_BIN" ] || { echo "[numas] opencode 产物缺失: $OPENCODE_BIN" >&2; exit 1; }

# --- step 4/5: extensions 打包 (.vsix → registry/vsix) --------------------------
# 每扩展 npm run package; 依赖各扩展 node_modules (缺失自动 npm install).
EXT_DIRS=("$ROOT"/extensions/*/)
if [ -n "$(ls "$REGISTRY_VSIX_DIR"/*.vsix 2>/dev/null)" ] && [ "$FORCE_EXT" = false ]; then
  echo "[numas] step 4/5: registry/vsix 已有 .vsix, 跳过 (改扩展源码后带 --extensions 强制重打包)"
else
  echo "[numas] step 4/5: extensions 打包 → registry/vsix/"
  for d in "${EXT_DIRS[@]}"; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    echo "[numas]   package: $name"
    (cd "$d" && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run package)
  done
fi
VSIX_COUNT=$(ls "$REGISTRY_VSIX_DIR"/*.vsix 2>/dev/null | wc -l | tr -d ' ')
[ "$VSIX_COUNT" -gt 0 ] || { echo "[numas] registry/vsix 无 .vsix 产物 (extensions 打包失败?)" >&2; exit 1; }

# --- step 5/5: docker 组装 --------------------------------------------------------
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# tag 前缀: --registry xxx/yyy → xxx/yyy:tag (默认 docker.io/numas)
PREFIX="${REGISTRY:+$REGISTRY/}numas"
TAGS=()
if [ -n "$EXTRA_TAG" ]; then
  TAGS+=(-t "$EXTRA_TAG")
else
  TAGS+=(-t "${PREFIX}:v${VERSION}" -t "${PREFIX}:latest")
fi

echo "[numas] step 5/5: docker 组装镜像"
echo "[numas]   platform:   $PLATFORM"
echo "[numas]   sumi:       $SUMIDIST"
echo "[numas]   opencode:   $OPENCODE_BIN"
echo "[numas]   extensions: $REGISTRY_VSIX_DIR ($VSIX_COUNT .vsix)"
echo "[numas]   mode:       $([ "$PUSH" = true ] && echo push || echo load)"

docker buildx build \
  --platform "$PLATFORM" \
  --build-arg "NUMAS_VERSION=$VERSION" \
  --build-arg "NUMAS_GIT_SHA=$GIT_SHA" \
  --build-arg "OPENCODE_ARTIFACT=opencode-${TARGET_NAME}" \
  "${TAGS[@]}" \
  ${NO_CACHE:-} \
  $([ "$PUSH" = true ] && echo --push || echo --load) \
  .

echo ""
echo "[numas] 构建完成: ${TAGS[*]}"
echo "[numas]   运行: docker run --rm -p 4096:4096 ${TAGS[1]:-${TAGS[0]}}"
echo "[numas]   挂项目目录: docker run --rm -p 4096:4096 -v \"\$(pwd):/app\" ${TAGS[1]:-${TAGS[0]}}"
echo "[numas]   改端口 (-e PORT 改容器内监听, -p 宿主映射必须配套一致):"
echo "[numas]     docker run --rm -p 8080:8080 -e PORT=8080 ${TAGS[1]:-${TAGS[0]}}"
