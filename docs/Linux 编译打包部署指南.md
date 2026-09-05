# Linux 服务器编译打包部署指南

> 目标: 在 Linux x86_64 服务器上成功构建并运行 numas。
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

**核心铁律**:
1. **opencode 二进制必须在 mac 上用 bun 1.4.0 交叉编译** (`NUMAS_TARGET=linux-x64`),
   不要用服务器 bun 本机构建 (bun 1.4.2 产物崩)。
2. **服务器不要跑 `node dev.js`** — dev.js 会用服务器 bun 重编 opencode, 把好产物覆盖回坏产物。
   服务器只跑产物 (手动起 opencode web)。
3. sumi UI 是纯浏览器产物 (平台无关), 在哪 build 都行, 拷贝到 `--web-ui` 指向目录即可。
4. 换 bun 版本 = 必须重新冒烟验证 fs/session/pty (§4)。

---

## 2. 前置环境 (一次性)

### 2.1 mac 开发机 (构建机)

```bash
# bun 1.4.0 (已锁版本; 安装指定版本)
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
export PATH="$HOME/.bun/bin:$PATH"
bun -v   # 1.4.0
```

### 2.2 服务器 (运行机, x86_64)

```bash
# 基础: git / curl / python3 / lsof (opencode 端口扫描依赖)
apt-get install -y git curl python3 lsof

# node (非必需 — 若只在服务器跑产物, 不需要 node; 需要 dev.js 才装)
# curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
```

服务器上需要有: `~/numas` 代码 (git pull 最新) + 依赖 (sumi/node_modules 等)。
若代码全新克隆: 依赖安装照 §5.3 (依赖装齐后产物路径即 §3)。

---

## 3. 一次完整部署实操 (已验证, 照抄可复现)

> 场景: 服务器 `~/numas` 已有代码, 服务需要更新 (或从坏产物恢复)。

### 第 1 步: mac 上交叉编译 linux-x64 产物

```bash
cd /Users/<you>/numas/opencode/packages/opencode

# ① 先暂移本机 darwin 产物 (build.ts 会 rm 整个 dist)
mv dist/opencode-darwin-arm64 /var/folders/.../darwin-bak

# ② 交叉编译 linux-x64 (服务器是 x86_64)
NUMAS_TARGET=linux-x64 bun run script/build.ts --skip-embed-web-ui

# ③ 恢复 darwin 产物
mv /var/folders/.../darwin-bak dist/opencode-darwin-arm64

# ④ 确认产物 (~141MB)
ls -la dist/opencode-linux-x64/bin/opencode
```

### 第 2 步: mac 上构建 sumi UI (如需同步最新 UI)

```bash
cd numas/sumi && npm run build
# 产物: sumi/dist/ (index.html + main.*.js + opensumi.*.js 等, 平台无关)
```

### 第 3 步: 上传到服务器并替换 (旧产物备份可回滚)

```bash
# mac 上执行 (服务器 IP/路径按实际)
scp opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode \
    root@192.168.24.71:/root/numas/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode.new

# UI 有更新时整目录 rsync (覆盖 --web-ui 指向的 sumi/dist)
# rsync -az --delete sumi/dist/ root@192.168.24.71:/root/numas/sumi/dist/

# 服务器上执行
cd /root/numas/opencode/packages/opencode/dist/opencode-linux-x64/bin
mv opencode opencode.bak-$(date +%H%M)      # 备份旧产物
mv opencode.new opencode
chmod +x opencode
./opencode --version                         # 冒烟: 输出 numas-v0.1.0-<时间戳>
```

### 第 4 步: 杀掉旧服务进程树

服务器上服务若由 dev.js 前台/后台拉起 (`npm run dev → node dev.js → opencode web`), 全杀:

```bash
ps -ef | grep -E "dev.js|opencode web" | grep -v grep
# 逐个 kill (opencode web 进程 + node dev.js + npm run dev / sh -c 的 pid)
kill <opencode_pid> <dev.js_pid> <npm_pid>
sleep 2
ps -ef | grep "opencode web" | grep -v grep    # 确认无残留
```

### 第 5 步: 手动起 opencode (绕过 dev.js — 关键!)

> **为什么不用 `node dev.js`**: dev.js 会用服务器 bun 重新编译 opencode, 覆盖刚上传的好产物。
> 服务器只负责跑产物, 构建一律在 mac 做。

```bash
cd /root/numas
mkdir -p .tmp
nohup ./opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode web \
  --hostname 0.0.0.0 --port 24096 --cors "*" \
  --registry /extensions \
  --extensions-dir /root/numas/registry/vsix \
  --web-ui /root/numas/sumi/dist \
  > .tmp/dev-remote.log 2>&1 &

# 等 5-8 秒
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:24096/    # 200
tail -5 .tmp/dev-remote.log
```

> 改端口: 改 `--port` (默认 24096)。

### 第 6 步: 冒烟验证 (全过才算成功, 缺一即查 bun 版本产物)

```bash
H="x-opencode-directory: /root/numas"
B=http://127.0.0.1:24096

# ① 纯 global 端点 (不依赖 workspace layer)
curl -s $B/global/health                        # {"healthy":true,...}

# ② workspace 数据层 (跨平台 bug 重灾区 — 必测!)
curl -s -w "[%{http_code}]\n" "$B/api/fs/list?path=." -H "$H"          # 200 + 文件数组
curl -s -w "[%{http_code}]\n" "$B/api/fs/stat?path=README.md" -H "$H"  # 200
curl -s -o /dev/null -w "[%{http_code}]\n" -X POST "$B/api/fs/write" \
  -H "Content-Type: application/json" -H "$H" \
  -d '{"path":".tmp/smoke.txt","content":"aGk="}'                        # 204
curl -s -w "[%{http_code}]\n" -X POST "$B/pty" -H "Content-Type: application/json" -H "$H" \
  -d '{"cwd":"/root/numas","cols":80,"rows":24}'                         # 200 + id

# ③ 日志无错
grep -vE "ports\] scan" .tmp/dev-remote.log | tail
```

**跨平台产物崩的特征 (判定工具链问题而非代码):**
- `fs/session/pty/prompt` 等所有带数据端点 500, 纯 global 端点 (health/path/shells) 正常
- 日志 (`/root/.local/share/opencode/log/opencode.log`): `TypeError: undefined is not an object (evaluating 'a.name')`
- 处置: 换 mac 交叉产物替换 → 重启 → 重跑冒烟 (90% 即好)

---

## 4. UI 验证三层 (Explorer / 终端 / AI)

浏览器开 `http://SERVER:24096/`, 逐层验证:

1. **Explorer**: 文件树显示 → 新建文件/目录成功落盘 (第一次 write 可能有 ~28s 一次性初始化, 之后毫秒级; 属正常)
2. **终端**: 底部「终端」tab → bash 会话出现, 输入命令有回显 (xterm 是 canvas 渲染, 验证看服务器 pty 进程: `ps -ef | grep "bash -l"`)
3. **AI**: 发消息看回复。**注意**: 免费上游 (OpenCode Zen / Nvidia) 可能 502 过载
   (`Service temporarily overloaded`) — 属上游问题; 链路正常的表现 = 服务端无 TypeError、有 stream 日志

---

## 5. 服务器本机构建 (备选; bun 版本必须对齐 1.4.0)

### 5.1 装 bun 1.4.0

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
export PATH="$HOME/.bun/bin:$PATH"
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
~/.bun/bin/bun --version     # 必须 1.4.0 (1.4.2 产物崩!)
```

### 5.2 本机构建产物

```bash
cd ~/numas/opencode/packages/opencode
NUMAS_TARGET=linux-x64 ~/.bun/bin/bun run script/build.ts --skip-embed-web-ui
```

### 5.3 全新克隆的依赖安装 (首次)

```bash
cd ~/numas/sumi && npm install        # 含 postinstall 框架 patch (fixLayout 等)
cd ~/numas/opencode && ~/.bun/bin/bun install
```

---

## 6. 常见坑速查

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 数据端点全 500 + `TypeError a.name` | 服务器 bun 版本构建产物崩 (1.4.2) | 换 mac bun 1.4.0 交叉产物 (§3) |
| 换产物重启后仍旧坏 | dev.js 自动重编覆盖了产物 | 手动起产物 (§3 第 5 步), 别跑 dev.js; 核对产物时间戳/`--version` |
| `/proxy` 404 + scan `listenCands=0` | 缺 lsof | `apt install lsof` |
| AI 502 overloaded | 上游免费模型过载 | 重试/换模型/配自有 key |
| 首次 write ~28s 后恢复 | opencode 一次性初始化 | 正常, 不等即可 |
| 服务日志不可回溯 | 前台跑 pts / 无重定向 | 必须 nohup 重定向到 `.tmp/dev-remote.log` |

---

## 7. 关键文件位置 (服务器)

- 项目: `~/numas`
- opencode 产物: `~/numas/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode`
- 服务日志: `~/numas/.tmp/dev-remote.log`
- opencode 运行日志: `/root/.local/share/opencode/log/opencode.log` (Effect logError 真实堆栈)
- opencode 数据: `/root/.local/share/opencode/opencode-main.db`
- 浏览器 storage: `/root/.codeblitz/`
- UI 静态产物: `~/numas/sumi/dist` (opencode `--web-ui` 指向)
