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