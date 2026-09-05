# Linux 服务器编译打包部署指南

> 目标: 在 Linux x86_64 服务器上成功构建并运行 numas (dev.js 模式 / docker 产物)。
> 背景教训 (2026-09-05 实测): 服务器用 bun 1.4.2 本机构建的 opencode linux-x64 产物
> 运行时崩溃 — 所有走数据序列化的端点 (fs/session/pty/prompt) 报
> `TypeError: undefined is not an object (evaluating 'a.name')` 全 500; 换 mac bun 1.4.0
> 交叉编译的 linux-x64 产物后一切正常。**构建工具链 (bun) 版本必须与已验证环境一致。**

---

## 1. 结论先行 (怎么才能成功)

| 方式 | 可行性 | 说明 |
| --- | --- | --- |
| **mac 开发机交叉编译 → 产物上传服务器** | ✅ 推荐 (已验证) | 与 docker 镜像构建同法; mac bun 1.4.0 产物在 x64 服务器实测正常 |
| 服务器本机 `bun run script/build.ts` | ⚠️ 需锁定 bun 版本 | 本次服务器 bun **1.4.2** 产物运行时崩; 若服务器 bun 与 mac 一致 (1.4.0) 再验证 |
| 服务器本机 dev.js 全流程 | ⚠️ 同本机 bun 产物风险 | dev.js 的 opencode build 步即上述本机编译 |

**核心铁律: 产物用哪个 bun 编的, 尽量与「验证过能跑」的环境一致; 换 bun 版本 = 必须重新冒烟验证 fs/session/pty。**

---

## 2. 前置环境

### 2.1 服务器基础依赖

```bash
# node (dev.js / sumi webpack 用; 建议 20+, 18 也能跑但未充分验证)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs

# git / curl / python3 (dev.js 启动工具链常用)
apt-get install -y git curl python3

# lsof (opencode 端口扫描依赖, 缺失 → 端口面板全空)
apt-get install -y lsof
```

### 2.2 bun (opencode 构建/运行核心)

```bash
# 安装固定版本 (不要装最新! 本次 bun 1.4.2 产物有运行时 bug)
curl -fsSL https://bun.sh/install | bash    # 装完是 latest → 用下面降级到 1.4.0
~/.bun/bin/bun upgrade --canary             # 不需要
# 直接下载指定版本覆盖:
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"   # 指定版本安装

# PATH (非交互 shell 默认不含 ~/.bun/bin)
export PATH="$HOME/.bun/bin:$PATH"
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
```

> **为什么锁 1.4.0**: opencode fork (numas) 在 mac bun 1.4.0 交叉编译的 linux-arm64/x64
> 产物均验证正常; bun 1.4.2 的 linux-x64 产物运行时崩 (bun 版本间单文件打包差异)。
> 换 bun 版本前先在 mac 交叉编译冒烟, 或服务器编完立刻跑 §4 冒烟清单。

---

## 3. 两种构建方式

### 方式 A (推荐): mac 交叉编译, 产物上传

在 mac 开发机 (与 docker 镜像构建同源, bun 1.4.0):

```bash
cd numas/opencode/packages/opencode
# build.ts 会 rm 整个 dist → 先把本机 darwin 产物暂移
mv dist/opencode-darwin-arm64 /var/folders/.../darwin-bak   # 或 .tmp/

# 交叉编译 linux-x64 (服务器是 x86_64)
NUMAS_TARGET=linux-x64 bun run script/build.ts --skip-embed-web-ui

# 恢复 darwin 产物
mv /var/folders/.../darwin-bak dist/opencode-darwin-arm64

# 产物: dist/opencode-linux-x64/bin/opencode
ls -la dist/opencode-linux-x64/bin/opencode
./dist/opencode-linux-x64/bin/opencode --version   # 本机冒烟 (mac 跑 linux 二进制会 exec format error, 属正常; 冒烟在服务器做)
```

上传到服务器并替换 (保留旧产物可回滚):

```bash
scp dist/opencode-linux-x64/bin/opencode root@SERVER:/root/numas/.../bin/opencode.new
ssh root@SERVER 'cd .../bin && mv opencode opencode.bak-$(date +%H%M) && mv opencode.new opencode && chmod +x opencode && ./opencode --version'
```

### 方式 B: 服务器本机构建 (bun 版本对齐后)

```bash
cd ~/numas/opencode/packages/opencode
~/.bun/bin/bun --version          # 必须与 mac 一致 (1.4.0)
NUMAS_TARGET=linux-x64 ~/.bun/bin/bun run script/build.ts --skip-embed-web-ui
```

---

## 4. 启动 + 冒烟验证清单 (构建是否成功的关键)

### 4.1 dev.js 启动 (权限/日志注意)

```bash
cd ~/numas
# 输出必须重定向到文件! 直接前台跑 pts 上日志不可回溯, 排查全靠它
mkdir -p .tmp
nohup node dev.js > .tmp/dev-remote.log 2>&1 &
tail -f .tmp/dev-remote.log
```

> dev.js 会自动: sumi webpack build → opencode build (产物存在可能跳过/重建) → spawn opencode。
> 若 dev.js 重编 opencode 用了服务器 bun (版本错) 会覆盖好产物 — 验证后留意产物时间戳。

### 4.2 冒烟清单 (产物/服务健康度, 全部过才算成功)

```bash
H="x-opencode-directory: /root/numas"
B=http://127.0.0.1:24096

# ① 纯 global 端点 (不依赖 workspace layer; 崩了也只代表进程活着)
curl -s $B/global/health                        # {"healthy":true,...}
curl -s $B/path -H "$H"                          # directory/home 正常

# ② workspace 数据层 (跨平台 bug 重灾区 — 必测!)
curl -s -w "[%{http_code}]\n" "$B/api/fs/list?path=." -H "$H"        # 200 + 文件数组
curl -s -w "[%{http_code}]\n" "$B/api/fs/stat?path=README.md" -H "$H" # 200
curl -s -o /dev/null -w "[%{http_code}]\n" -X POST "$B/api/fs/write" -H "Content-Type: application/json" -H "$H" -d '{"path":".tmp/smoke.txt","content":"aGk="}'   # 204
curl -s -o /dev/null -w "[%{http_code}]\n" -X POST "$B/pty" -H "Content-Type: application/json" -H "$H" -d '{"cwd":"/root/numas","cols":80,"rows":24}'          # 200 + id

# ③ 观察日志错误
grep -vE "ports\] scan" .tmp/dev-remote.log | tail   # 不应有 ERROR / TypeError
```

**跨平台产物崩的特征 (判定工具链问题而非代码):**
- `fs/session/pty/prompt` 等所有带数据端点 500, 纯 global 端点 (health/path/shells) 正常
- 日志: `TypeError: undefined is not an object (evaluating 'a.name')` 堆栈在 `/$bunfs/...`
- 处置: 换 mac 交叉产物替换 → 重启 → 重跑冒烟 (90% 即好)

### 4.3 重启服务 (替换产物后)

```bash
# 杀 dev.js 树 (dev.js → node dev.js → opencode web)
pkill -f "node dev.js"; pkill -f "opencode web"; sleep 2
cd ~/numas && nohup node dev.js > .tmp/dev-remote.log 2>&1 &
# 或只重启 opencode (不动 sumi):
nohup ./opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode web \
  --hostname 0.0.0.0 --port 24096 --cors "*" \
  --registry /extensions --extensions-dir /root/numas/registry/vsix \
  --web-ui /root/numas/sumi/dist > .tmp/dev-remote.log 2>&1 &
```

---

## 5. 验证 UI 三层 (Explorer / 终端 / AI)

浏览器开 `http://SERVER:24096/`, 逐层验证:

1. **Explorer**: 文件树显示 → 新建文件/目录成功落盘 (第一次 write 可能有 ~28s 一次性初始化, 之后毫秒级; 属正常)
2. **终端**: 底部「终端」tab → bash 会话出现, 输入命令有回显 (xterm 是 canvas 渲染, 验证看服务器 pty 进程: `ps -ef | grep "bash -l"`)
3. **AI**: 发消息看回复。**注意**: 免费上游 (OpenCode Zen / Nvidia) 可能 502 过载
   (`Service temporarily overloaded`) — 属上游问题, 链路正常的表现是请求发出、有 stream 日志、
   服务端无 TypeError; 生产建议配自有 provider key

---

## 6. 常见坑速查

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 数据端点全 500 + `TypeError a.name` | 服务器 bun 版本构建产物崩 (1.4.2) | 换 mac bun 1.4.0 交叉产物 (§3-A) |
| `/proxy` 404 + scan `listenCands=0` | 缺 lsof | `apt install lsof` |
| AI 502 overloaded | 上游免费模型过载 | 重试/换模型/配自有 key |
| 首次 write ~28s 后恢复 | opencode 一次性初始化 | 正常, 不等即可 |
| dev.js 起在 pts 前台 | 日志不可回溯 | 必须 nohup 重定向到 `.tmp/` |
| 替换产物后仍旧行为 | dev.js 自动重编覆盖了产物 | 核对产物时间戳/`--version` 时间戳 |

---

## 7. 关键文件位置

- 项目: `~/numas`
- opencode 产物: `~/numas/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode`
- 服务日志: `~/numas/.tmp/dev-remote.log`
- opencode 运行日志: `/root/.local/share/opencode/log/opencode.log` (Effect logError 真实堆栈)
- opencode 数据: `/root/.local/share/opencode/opencode-main.db`
- 浏览器 storage: `/root/.codeblitz/`
