# 手动构建二进制安装包做法
opencode/packages/opencode/ 下执行:
NUMAS_TARGET=linux-x64 bun run script/build.ts

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