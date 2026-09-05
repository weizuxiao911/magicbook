# 手动构建二进制安装包做法
opencode/packages/opencode/ 下执行:
NUMAS_TARGET=linux-x64 bun run script/build.ts

# 跨平台打包 (NUMAS_TARGET=os-arch,  glibc/非 baseline 标准版)
NUMAS_TARGET=linux-arm64 bun run script/build.ts     # Linux ARM64
NUMAS_TARGET=linux-x64   bun run script/build.ts     # Linux x64 glibc (默认)
NUMAS_TARGET=darwin-arm64 bun run script/build.ts    # macOS Apple Silicon
NUMAS_TARGET=darwin-x64   bun run script/build.ts    # macOS Intel
NUMAS_TARGET=win32-x64    bun run script/build.ts    # Windows x64
NUMAS_TARGET=win32-arm64  bun run script/build.ts    # Windows ARM64
# 注: NUMAS_TARGET 用原始 os 名 (linux/darwin/win32),
#     但 dist 目录命名对 windows 平台用 "windows": dist/opencode-windows-x64/bin/opencode.exe
# 产物位置: dist/opencode-<os>-<arch>/bin/opencode (.exe)

# 全平台全变体一次性出 (含 musl + baseline,  无 NUMAS_TARGET 时走全部)
bun run script/build.ts
# 当前平台单出 (含 baseline 需加 --baseline)
bun run script/build.ts --single
bun run script/build.ts --single --baseline

# 手动推送到 GitHub Release
# 前置: gh CLI 已登录 (gh auth status),  对目标 repo 有 release 写权限
# 自动通道 (build.ts 内置,  OPENCODE_RELEASE=1 + GH_REPO=owner/repo):
#   OPENCODE_RELEASE=1 GH_REPO=weizuxiao911/numas \
#     NUMAS_TARGET=linux-x64 bun run script/build.ts
#   → 触发 build.ts 末尾自动 tar/zip + gh release upload v${Script.version}
#   → tag = v<Script.version>,  numas fork 版本形如 numas-v0.1.0-202609050903
#   → tag 最终: vnumas-v0.1.0-202609050903

# 手动通道 (跳过 OPENCODE_RELEASE,  自己控制):
# 1. 正常构建
NUMAS_TARGET=linux-x64 bun run script/build.ts
# 2. 打 tar/zip (build.ts 274-283 用的就是这个命令)
cd opencode/packages/opencode/dist/opencode-linux-x64/bin
tar -czf ../../../opencode-linux-x64.tar.gz opencode
cd ../../..
zip -r opencode-darwin-arm64.zip opencode-darwin-arm64/bin        # 非 linux 走 zip
# 3. 创建 release + 上传
gh release create v0.1.0 ./dist/opencode-linux-x64.tar.gz \
  --repo weizuxiao911/numas --title "v0.1.0" --notes "manual release"
# 后续追加资产:
gh release upload v0.1.0 ./dist/opencode-darwin-arm64.zip --repo weizuxiao911/numas --clobber
# 注意事项:
#   - gh release 仅 github.com;  gitlab 走 glab release create 或 REST API
#   - gh CLI 不在容器精简镜像里 (避坑 #18 同源: 容器无 lsof/部分 CLI),  本地或 CI runner 执行
#   - tar/zip 前确认产物可执行位 (chmod +x dist/<target>/bin/opencode),
#     GitHub artifact 下载会丢 x bit,  见 publish.ts:17

# 本地源码直接运行 (opencode 单包, 走 TUI 入口)
cd opencode/packages/opencode
bun install
bun run dev                 # = bun run --conditions=browser ./src/index.ts, 进 TUI
bun run dev:temporary       # = bun run --conditions=browser ./src/temporary.ts

# 集成模式 (numas 整体: sumi + opencode, 启 web + 自动开浏览器)
# 项目根:
node dev.js                          # 默认 :24096, --registry=/extensions
node dev.js --port 8080              # 自定义端口
node dev.js --fast                   # 跳过 build/cp (复用产物)
node dev.js --force-build            # 强制重装依赖 + 重编
NUMAS_PORT=8080 node dev.js          # 环境变量等同 --port