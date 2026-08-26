/**
 * 全部 chat 样式 — extensions/chat/webview/styles.ts
 * UI 设计不变, 仅搬迁位置.
 */

export const styles = `
/* 霓虹跑圈: 注册角度变量, 供 conic-gradient 光点绕边框旋转 */
@property --ab-neon-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
.chat {
  /* ========== 主题色板: 优先使用 IDE/VSCode 主题变量, 暗色兜底 ========== */
  /* 与 left slot 保持一致 (var(--app-surface-muted)) */
  --ai-bg: var(--app-surface-muted, var(--editor-background, #181818));
  /* 弹层/浮起表面: 不允许透明, 用 editorWidget-background (VSCode 标准弹层色) */
  --ai-bg-elev: var(--editorWidget-background, var(--sideBar-background, var(--ai-bg, #1c1c22)));
  --ai-bg-input: color-mix(in srgb, var(--ai-fg, #e5e7eb) 5%, var(--ai-bg-elev));
  --ai-fg: var(--editor-foreground, #e5e7eb);
  --ai-fg-muted: var(--descriptionForeground, #9ca3af);
  --ai-border: var(--panel-border, var(--editorWidget-border, rgba(255,255,255,0.08)));
  --ai-divider: var(--editor-lineHighlightBorder, rgba(255,255,255,0.06));
  --ai-hover: var(--list-hoverBackground, rgba(255,255,255,0.06));
  --ai-active: var(--list-activeSelectionBackground, rgba(99,102,241,0.18));
  --ai-accent: var(--button-background, #6366f1);
  --ai-accent-fg: var(--button-foreground, #ffffff);
  --ai-accent-soft: var(--list-activeSelectionBackground, rgba(99,102,241,0.18));
  --ai-danger: var(--errorForeground, #fca5a5);
  --ai-danger-bg: var(--inputValidation-errorBackground, rgba(239,68,68,0.18));
  --ai-danger-border: var(--inputValidation-errorBorder, rgba(239,68,68,0.4));
  --ai-success: var(--terminal-ansiGreen, #4ade80);
  --ai-success-bg: color-mix(in srgb, var(--ai-success) 22%, var(--ai-bg-elev));
  --ai-warning: var(--editorWarning-foreground, #facc15);
  --ai-shadow: 0 16px 40px rgba(0,0,0,0.5);
  --ai-radius: 10px;

  /* ========== 金属 3D 风格 (Apple 质感, 基于主题色派生 = 兼容明/暗主题) ========== */
  /* 金属: 主题前景色漂白 → 高光; 主题背景压暗 → 暗部 */
  --ai-metal-hi: color-mix(in srgb, var(--ai-fg) 22%, #ffffff);
  --ai-metal-mid: color-mix(in srgb, var(--ai-fg) 10%, var(--ai-bg-elev));
  --ai-metal-lo: color-mix(in srgb, var(--ai-fg) 2%, #000000);
  --ai-metal: linear-gradient(180deg, var(--ai-metal-hi) 0%, var(--ai-metal-mid) 45%, var(--ai-metal-lo) 100%);
  --ai-metal-edge: color-mix(in srgb, var(--ai-fg) 18%, transparent);
  /* 金属强调 (发送键/logo): 主题强调色 + 高光顶 */
  --ai-metal-accent-hi: color-mix(in srgb, var(--ai-accent) 55%, #ffffff);
  --ai-metal-accent: linear-gradient(180deg, var(--ai-metal-accent-hi) 0%, var(--ai-accent) 55%, color-mix(in srgb, var(--ai-accent) 75%, #000000) 100%);
  /* 磨砂玻璃表面 (卡片/弹层) */
  --ai-glass-bg: color-mix(in srgb, var(--ai-bg-elev) 74%, transparent);
  --ai-glass-blur: blur(18px) saturate(160%);
  --ai-glass-edge: var(--ai-border);
  --ai-press-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 3px 10px color-mix(in srgb, #000 32%, transparent);
  --ai-pop-shadow: 0 24px 60px color-mix(in srgb, #000 55%, transparent), 0 0 0 1px var(--ai-glass-edge) inset;
  /* 抛光球面高光 (圆钮/图标) */
  --ai-chrome: radial-gradient(circle at 32% 24%, var(--ai-metal-hi) 0%, var(--ai-metal-mid) 40%, var(--ai-metal-lo) 92%);
  /* 霓虹灯强调色: 基于 accent 但强制饱和可见 (accent 可能是半透明白, 直接发光会不可见) */
  --ai-neon: color-mix(in srgb, var(--ai-accent) 55%, #7c3aed);

  display: flex; flex-direction: column; height: 100%;
  background: var(--ai-bg);
  color: var(--ai-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  overflow: hidden;
}

/* Topbar — 透明 (无背景, 露出下层主题色) + 底部投影分隔 (无顶部白色高光) */
.chat__topbar {
  height: 36px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow:
    0 3px 10px color-mix(in srgb, #000 22%, transparent);
  flex-shrink: 0;
}
.chat__brand { display: flex; align-items: center; gap: 8px; }
.chat__logo {
  width: 22px; height: 22px; border-radius: 7px;
  background: var(--ai-metal-accent);
  color: var(--ai-accent-fg); font-weight: 700; font-size: 12px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 2px 6px color-mix(in srgb, #000 35%, transparent);
  text-shadow: 0 1px 1px color-mix(in srgb, #000 30%, transparent);
}
.chat__brand-name { font-weight: 600; font-size: 13px; }
.chat__top-actions { display: flex; align-items: center; gap: 2px; }
.chat__icon-btn {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 7px;
  color: var(--ai-fg-muted);
  cursor: pointer;
  transition: background .12s, box-shadow .12s;
}
.chat__icon-btn:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__icon-btn:active { box-shadow: var(--ai-press-shadow); }
.chat__login-btn {
  height: 26px; padding: 0 12px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ai-accent, #0e639c); border: none; border-radius: 7px;
  color: #fff; font-size: 12px; font-weight: 600;
  cursor: pointer;
  transition: opacity .12s, background .12s;
}
.chat__login-btn:hover { opacity: .9; }
.chat__login-gate {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px;
  padding: 24px;
}
.chat__login-title { font-size: 20px; font-weight: 700; color: var(--ai-fg); }
.chat__login-desc { font-size: 13px; color: var(--ai-fg-muted); }

/* Todos bar */
/* Todos dock (above composer, OpenCode style) */
.chat__todos-dock {
  margin: 8px 8px 0;
  padding: 0;
  background: var(--ai-input-bg);
  border: none;
  border-radius: 10px;
  flex-shrink: 0;
  overflow: hidden;
}
.chat__todos-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}
.chat__todos-title {
  font-size: 12px; color: var(--ai-fg-muted);
}
.chat__todos-caret {
  font-size: 10px; color: var(--ai-fg-muted);
}
.chat__todos-list {
  list-style: none; margin: 0; padding: 0 12px 8px 32px;
}
.chat__todo-item {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 4px 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ai-fg);
}
.chat__todo-item.is-completed {
  color: var(--ai-fg-muted);
  text-decoration: line-through;
  opacity: 0.7;
}
.chat__todo-item.is-in_progress {
  font-weight: 500;
  color: var(--ai-fg);
}
.chat__todo-check {
  flex-shrink: 0;
  margin-left: -22px;
  font-size: 12px;
  color: var(--ai-fg-muted);
  width: 14px;
  text-align: center;
}
.chat__todo-item.is-in_progress .chat__todo-check { color: var(--ai-warning); }
.chat__todo-item.is-completed .chat__todo-check { color: var(--ai-success); }

/* Messages area */
.chat__messages {
  flex: 1; overflow-y: auto; overflow-x: hidden; min-width: 0;
  padding: 16px 20px;
  display: flex; flex-direction: column; min-width: 0;
}
.chat__msg { margin: 6px 0; display: flex; min-width: 0; max-width: 100%; }
.chat__msg.is-user { justify-content: flex-end; }
.chat__msg.is-assistant { justify-content: flex-start; }
/* assistant 消息体撑满消息列宽, 卡片宽度统一适配 */
.chat__msg.is-assistant > .chat__msg-body { flex: 1; min-width: 0; }
.chat__msg-user-col { display: flex; flex-direction: column; align-items: flex-end; max-width: 100%; min-width: 0; }
.chat__msg-body {
  max-width: 100%; min-width: 0;
  color: var(--ai-fg);
  font-size: 13px; line-height: 1.65;
  overflow-wrap: anywhere;
}
.chat__msg-body > * { min-width: 0; max-width: 100%; }
/* 卡片/文本统一占满消息体宽度 */
.chat__msg-body > div,
.chat__msg-body > section,
.chat__msg-body > aside,
.chat__msg-body > .chat-md,
.chat__msg-body > .tool,
.chat__msg-body > .todo,
.chat__msg-body > .reason,
.chat__msg-body > .q {
  width: 100%; box-sizing: border-box;
}
.chat__msg-body pre, .chat__msg-body code {
  max-width: 100%;
  overflow-x: auto;
  word-break: break-all;
  white-space: pre-wrap;
  box-sizing: border-box;
}
.chat__msg-bubble.is-user {
  display: inline-block;
  background: var(--ai-hover);
  color: var(--ai-fg);
  padding: 7px 12px;
  border-radius: 12px;
  word-wrap: break-word; overflow-wrap: anywhere; white-space: pre-wrap;
  font-size: 13px; line-height: 1.5;
  max-width: 100%;
}
.chat__msg-user-text { white-space: pre-wrap; }
.chat__part-file--image {
  display: block; max-width: 240px; max-height: 240px;
  border-radius: 8px; margin-top: 6px;
  object-fit: contain;
}
.chat__part-file {
  display: inline-flex; align-items: center; gap: 8px;
  margin-top: 6px; max-width: 100%;
}
.chat__part-file a {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: var(--ai-hover);
  border: none;
  border-radius: 8px;
  color: var(--ai-fg);
  text-decoration: none;
  font-size: 12.5px;
  max-width: 100%;
}
.chat__part-file-icon { flex-shrink: 0; color: var(--ai-fg-muted); display: inline-flex; }
.chat__part-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 强制: 消息列内所有容器不要溢出 (thinking / tool / reason / q-card 卡片都靠这条) */
.chat__msg-body > div,
.chat__msg-body > pre,
.chat__msg-body > section,
.chat__msg-body > aside {
  min-width: 0; max-width: 100%; overflow-x: auto;
  box-sizing: border-box;
}
.chat__msg-meta {
  display: flex;
  align-items: center; gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--ai-fg-muted);
}
.chat__msg-meta.is-user { justify-content: flex-end; }
.chat__msg-copy {
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 5px;
  color: var(--ai-fg-muted); cursor: pointer; padding: 0;
}
.chat__msg-copy:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__msg-sep { opacity: 0.5; }
.chat__msg-model { font-weight: 500; }

/* Error */
.chat__error {
  margin: 0 12px 8px;
  padding: 8px 12px;
  background: var(--ai-danger-bg);
  border: 1px solid var(--ai-danger-border);
  border-radius: 8px;
  color: var(--ai-danger); font-size: 12px;
  display: flex; align-items: center; gap: 10px;
}
.chat__error button {
  margin-left: auto;
  background: var(--ai-hover); border: none; color: var(--ai-danger);
  padding: 3px 10px; border-radius: 5px; cursor: pointer; font-size: 11px;
}

/* 信息/成功提示 (非错误) — 蓝色调, 与红色错误区分 */
.chat__notice {
  margin: 0 12px 8px;
  padding: 8px 12px;
  background: var(--ai-accent-soft);
  border: 1px solid var(--ai-border);
  border-radius: 8px;
  color: var(--ai-fg); font-size: 12px;
  display: flex; align-items: center; gap: 10px;
  white-space: pre-wrap; word-break: break-word;
}
.chat__notice-text { flex: 1; min-width: 0; }
.chat__notice button {
  flex-shrink: 0;
  background: transparent; border: none; color: var(--ai-fg-muted);
  cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 4px;
}
.chat__notice button:hover { color: var(--ai-fg); }

/* Composer */
.chat__composer {
  padding: 8px 12px 12px;
  flex-shrink: 0;
  position: relative;
}
.chat__input-wrap {
  position: relative;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--ai-fg) 10%, var(--ai-bg-elev)) 0%,
    var(--ai-bg-elev) 55%,
    color-mix(in srgb, var(--ai-fg) 2%, var(--ai-bg-elev)) 100%);
  border: none;
  border-radius: 16px;
  padding: 10px 12px 8px;
  box-shadow:
    0 1px 0 var(--ai-metal-edge) inset,          /* 顶部内高光 → 凸起 */
    0 2px 8px color-mix(in srgb, #000 24%, transparent); /* 底部投影 */
  transition: box-shadow .2s, background .2s;
  display: flex; flex-direction: column;
}
/* 霓虹灯: focus 时光点沿边框跑圈 (conic-gradient 旋转) + 呼吸光晕 */
.chat__input-wrap::before {
  content: '';
  position: absolute; inset: -2px;
  border-radius: 18px;
  padding: 2px;
  background: conic-gradient(
    from var(--ab-neon-angle),
    transparent 0deg,
    color-mix(in srgb, var(--ai-neon) 55%, transparent) 28deg,
    color-mix(in srgb, var(--ai-neon) 95%, #ffffff) 50deg,
    color-mix(in srgb, var(--ai-neon) 55%, transparent) 72deg,
    transparent 100deg,
    transparent 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  pointer-events: none;
  transition: opacity .5s ease;
  animation: ab-neon-rotate 3.6s linear infinite;
  z-index: 1;
}
.chat__input-wrap:focus-within::before {
  opacity: 1;
}
.chat__input-wrap:focus-within {
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--ai-neon) 10%, var(--ai-bg-elev)) 0%,
    var(--ai-bg-elev) 55%,
    color-mix(in srgb, var(--ai-fg) 2%, var(--ai-bg-elev)) 100%);
  animation: ab-neon-breathe 3.6s ease-in-out infinite;
}
@keyframes ab-neon-rotate {
  from { --ab-neon-angle: 0deg; }
  to   { --ab-neon-angle: 360deg; }
}
@keyframes ab-neon-breathe {
  0%, 100% { box-shadow:
    0 0 14px color-mix(in srgb, var(--ai-neon) 30%, transparent),
    0 0 4px color-mix(in srgb, var(--ai-neon) 42%, transparent),
    0 1px 0 var(--ai-metal-edge) inset,
    0 2px 8px color-mix(in srgb, #000 24%, transparent); }
  50% { box-shadow:
    0 0 26px color-mix(in srgb, var(--ai-neon) 56%, transparent),
    0 0 7px color-mix(in srgb, var(--ai-neon) 62%, transparent),
    0 1px 0 var(--ai-metal-edge) inset,
    0 2px 8px color-mix(in srgb, #000 24%, transparent); }
}
.chat__input-wrap textarea {
  width: 100%; resize: none;
  background: transparent; border: none; outline: none;
  color: var(--ai-fg);
  font-family: inherit; font-size: 13px; line-height: 1.55;
  padding: 4px 2px 12px; min-height: 56px; max-height: 220px;
  overflow-y: auto; display: block;
}
.chat__input-wrap textarea::placeholder { color: var(--ai-fg-muted); }

/* Attachment cards */
.chat__attach {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 0 2px 8px;
}
.chat__attach-card {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 180px;
  padding: 4px 6px;
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ai-fg);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset;
  transition: border-color .15s, background .15s;
}
.chat__attach-card:hover { border-color: var(--ai-accent); }
.chat__attach-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat__attach-thumb {
  width: 26px; height: 26px; object-fit: cover;
  border-radius: 5px; flex-shrink: 0;
}
.chat__attach-ic {
  flex-shrink: 0; width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 5px;
  background: var(--ai-input-bg);
  color: var(--ai-fg-muted);
}
.chat__attach-ic--lg { width: 52px; height: 52px; border-radius: 12px; }
.chat__attach-x {
  flex-shrink: 0;
  background: transparent; border: none; color: var(--ai-fg-muted);
  font-size: 13px; cursor: pointer; line-height: 1; padding: 0 2px;
}
.chat__attach-x:hover { color: var(--ai-danger); }

/* 附件预览 */
.chat__preview {
  width: min(680px, 100%);
  max-height: min(calc(100vh - 72px), 720px);
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 16px;
  box-shadow: var(--ai-pop-shadow);
  display: flex; flex-direction: column;
  overflow: hidden;
  animation: chat-pop .14s ease-out;
}
.chat__preview-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 16px;
  box-shadow: 0 1px 0 var(--ai-divider);
}
.chat__preview-name {
  flex: 1; min-width: 0;
  font-size: 13px; font-weight: 600; color: var(--ai-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat__preview-body {
  flex: 1; overflow: auto;
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  min-height: 200px;
}
.chat__preview-body img {
  max-width: 100%; max-height: calc(100vh - 220px);
  object-fit: contain;
  border-radius: 8px;
}
.chat__preview-file {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--ai-fg-muted);
}
.chat__preview-path {
  font-size: 12.5px;
  word-break: break-all;
  text-align: center;
}

.chat__input-bar {
  display: flex; align-items: center; gap: 4px;
}
.chat__select { position: relative; min-width: 0; flex: 0 1 auto; }
.chat__bar-spacer { flex: 1; }
.chat__bar-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 8px;
  background: transparent; border: none; border-radius: 8px;
  color: var(--ai-fg-muted);
  font-family: inherit; font-size: 13px;
  cursor: pointer; transition: background .12s, color .12s;
  max-width: 100%;
  min-width: 0;
  flex: 0 1 auto;
}
.chat__bar-btn > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 auto;
}
.chat__bar-btn:hover {
  background: var(--ai-hover);
  color: var(--ai-fg);
}
.chat__bar-plus { width: 28px; padding: 0; justify-content: center; }
.chat__spark { color: var(--ai-accent); }
.chat__send {
  width: 32px; height: 32px; border-radius: 10px;
  border: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ai-metal-accent); color: var(--ai-accent-fg);
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 3px 10px color-mix(in srgb, #000 35%, transparent);
  transition: filter .15s, opacity .15s, transform .06s;
  flex-shrink: 0;
}
.chat__send:hover:not(:disabled) { filter: brightness(1.12); }
.chat__send:active:not(:disabled) { transform: translateY(1px); }
.chat__send:disabled {
  opacity: 0.35; cursor: not-allowed;
  background: var(--ai-hover); color: var(--ai-fg-muted);
  box-shadow: none;
}
.chat__send--stop {
  background: var(--ai-danger-bg); color: var(--ai-danger);
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 2px 6px color-mix(in srgb, #000 25%, transparent);
}
.chat__stop-square {
  width: 9px; height: 9px;
  background: currentColor; border-radius: 2px;
}

/* Model picker — 居中全局模态框 + 遮罩 */
.chat__modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: var(--vscode-overlay-background, rgba(0,0,0,0.45));
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  animation: chat-fade .12s ease-out;
}
@keyframes chat-fade { from { opacity: 0; } to { opacity: 1; } }

.chat__modal {
  width: 560px; max-width: 100%;
  max-height: min(calc(100vh - 72px), 600px);
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 16px;
  box-shadow: var(--ai-pop-shadow);
  display: flex; flex-direction: column;
  overflow: hidden;
  animation: chat-pop .14s ease-out;
}
@keyframes chat-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* Header */
.chat__modal-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; padding: 20px 22px 12px;
}
.chat__modal-header--page {
  align-items: center; gap: 10px;
  padding: 18px 22px 8px;
}
.chat__modal-header-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.chat__modal-title {
  font-size: 17px; font-weight: 600; color: var(--ai-fg);
  display: inline-flex; align-items: center; gap: 8px;
}
.chat__modal-title-icon { color: var(--ai-accent); display: inline-flex; }
.chat__modal-count {
  font-size: 12px; font-weight: 400; color: var(--ai-fg-muted);
  margin-left: 2px;
}
.chat__modal-subtitle {
  font-size: 13px; color: var(--ai-fg-muted);
}
.chat__modal-back {
  width: 30px; height: 30px;
  background: transparent; border: none;
  color: var(--ai-fg-muted);
  cursor: pointer; padding: 0; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px;
}
.chat__modal-back:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__modal-btn-primary {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px;
  background: var(--ai-hover);
  border: 1px solid var(--ai-border);
  border-radius: 8px;
  color: var(--ai-fg);
  font-family: inherit; font-size: 13px; font-weight: 500;
  cursor: pointer; flex-shrink: 0;
}
.chat__modal-btn-primary:hover { background: var(--ai-hover); }

/* Search */
.chat__modal-search {
  display: flex; align-items: center; gap: 10px;
  margin: 12px 20px 8px;
  padding: 9px 14px;
  background: var(--ai-input-bg);
  border: 1px solid var(--ai-border);
  border-radius: 10px;
  color: var(--ai-fg-muted);
}
.chat__modal-search:focus-within {
  border-color: var(--ai-accent);
  background: var(--ai-accent-soft);
}
.chat__modal-search input {
  flex: 1; background: transparent; border: none; outline: none;
  color: var(--ai-fg);
  font-family: inherit; font-size: 14px;
}
.chat__modal-search input::placeholder { color: var(--ai-fg-muted); }

/* Body */
.chat__modal-body {
  flex: 1; overflow-y: auto;
  padding: 4px 16px 16px;
}
.chat__modal-body--apikey {
  padding: 8px 22px 22px;
}

.chat__modal-error {
  margin: 8px 6px;
  padding: 8px 12px;
  background: var(--ai-danger-bg);
  border: 1px solid var(--ai-danger-border);
  border-radius: 8px;
  color: var(--ai-danger); font-size: 13px;
}

/* select view: 分组模型列表 */
.chat__modal-group { padding: 2px 0; }
.chat__modal-group-title {
  padding: 10px 12px 6px;
  font-size: 12.5px; color: var(--ai-fg-muted);
  user-select: none;
}
.chat__modal-item {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 7px 12px;
  background: transparent; border: none; border-radius: 6px;
  color: var(--ai-fg);
  font-family: inherit; font-size: 13px;
  cursor: pointer; text-align: left;
}
.chat__modal-item:hover { background: var(--ai-hover); }
.chat__modal-item.is-active {
  background: var(--ai-active);
  color: var(--ai-fg);
}
.chat__modal-item.is-highlighted {
  background: var(--ai-hover);
  outline: 1px solid var(--ai-accent);
  outline-offset: -1px;
}
.chat__modal-item.is-highlighted.is-active {
  background: var(--ai-active);
}
.chat__modal-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat__skill-item { align-items: flex-start; }
.chat__skill-body {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 3px;
}
.chat__skill-name { font-weight: 600; color: var(--ai-fg); }
.chat__skill-desc {
  font-size: 12px; font-weight: 400; color: var(--ai-fg-muted);
  line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.chat__skill-loc {
  font-size: 10.5px; color: var(--ai-fg-muted); opacity: .7;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat__modal-tag {
  flex-shrink: 0;
  font-size: 10.5px; padding: 2px 7px; border-radius: 4px;
  background: var(--ai-success-bg);
  color: var(--ai-success);
}
.chat__modal-check { flex-shrink: 0; }
.chat__modal-empty {
  padding: 28px 16px; text-align: center;
  color: var(--ai-fg-muted); font-size: 13px;
}

.chat__modal-foot {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px;
  background: transparent;
  border: none;
  box-shadow: 0 -1px 0 var(--ai-divider);
  color: var(--ai-fg);
  font-family: inherit; font-size: 13px; font-weight: 500;
  cursor: pointer; text-align: left;
}
.chat__modal-foot:hover { background: var(--ai-input-bg); }

/* providers view: catalog 列表 */
.chat__modal-cat { padding: 2px 4px 12px; }
.chat__modal-cat-title {
  padding: 8px 12px;
  font-size: 13px; color: var(--ai-fg-muted);
  font-weight: 500;
}
.chat__modal-catrow {
  width: 100%; display: flex; align-items: center; gap: 12px;
  padding: 11px 14px;
  background: transparent; border: none; border-radius: 8px;
  color: var(--ai-fg);
  font-family: inherit; font-size: 15px;
  cursor: pointer; text-align: left;
}
.chat__modal-catrow:hover { background: var(--ai-hover); }
.chat__modal-catrow.is-highlighted {
  background: var(--ai-hover);
  outline: 1px solid var(--ai-accent);
  outline-offset: -1px;
}
.chat__modal-catrow.is-connected { opacity: 0.65; }
.chat__modal-catrow.is-highlighted.is-connected { opacity: 1; }
.chat__modal-caticon {
  width: 24px; height: 24px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ai-fg-muted);
}
.chat__modal-catname { flex: 1; min-width: 0; }

/* apikey view */
.chat__modal-apikey-desc {
  margin: 4px 0 18px;
  font-size: 14px; line-height: 1.6;
  color: var(--ai-fg-muted);
}
.chat__modal-apikey-label {
  display: block;
  font-size: 14px; font-weight: 600;
  color: var(--ai-fg);
  margin-bottom: 8px;
}
.chat__modal-apikey-input {
  width: 100%;
  padding: 11px 14px;
  background: var(--ai-input-bg);
  border: 1px solid var(--ai-accent);
  border-radius: 10px;
  color: var(--ai-fg);
  font-family: inherit; font-size: 14px;
  outline: none;
  box-sizing: border-box;
}
.chat__modal-apikey-input:focus {
  border-color: var(--ai-accent);
  background: var(--ai-accent-soft);
}
.chat__modal-apikey-actions {
  display: flex; justify-content: flex-start;
  margin-top: 18px;
}
.chat__modal-btn-continue {
  height: 38px; padding: 0 26px;
  background: var(--button-background, #3a3a42);
  border: 1px solid var(--ai-border);
  border-radius: 10px;
  color: var(--ai-accent-fg);
  font-family: inherit; font-size: 14px; font-weight: 600;
  cursor: pointer;
  box-shadow: var(--ai-shadow);
}
.chat__modal-btn-continue:hover:not(:disabled) { filter: brightness(1.12); }
.chat__modal-btn-continue:disabled { opacity: 0.5; cursor: not-allowed; }


/* Sessions modal — 历史会话 */
.chat__sess-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.chat__sess-clear {
  background: transparent; border: 1px solid var(--ai-border); border-radius: 6px;
  color: var(--ai-danger); font-size: 12px; cursor: pointer; padding: 4px 10px;
}
.chat__sess-clear:hover { background: var(--ai-danger-bg); }
.chat__sess-item { padding-right: 8px; }
.chat__sess-dir {
  flex-shrink: 0; max-width: 130px;
  font-size: 10.5px; color: var(--ai-fg-muted); opacity: .75;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat__sess-del {
  flex-shrink: 0; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 5px;
  color: var(--ai-fg-muted); cursor: pointer; padding: 0;
  opacity: 0;
}
.chat__modal-item:hover .chat__sess-del { opacity: 1; }
.chat__sess-del:hover { background: var(--ai-danger-bg); color: var(--ai-danger); }


/* ========== 命令 / 提及 弹层 (输入框上方, 与 agent-pop 风格统一) ========== */
.chat__cmd-pop {
  position: absolute; bottom: calc(100% + 6px); left: 12px; right: 12px;
  max-height: 280px; overflow-y: auto;
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 12px;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 12px 32px color-mix(in srgb, #000 40%, transparent);
  padding: 4px;
  z-index: 70;
}
.chat__cmd-list { display: flex; flex-direction: column; gap: 1px; }
.chat__cmd-item {
  display: flex; align-items: baseline; gap: 10px;
  width: 100%; padding: 6px 10px;
  background: transparent; border: none; border-radius: 6px;
  color: var(--ai-fg); font-family: inherit; text-align: left;
  cursor: pointer;
}
.chat__cmd-item--mention { align-items: center; }
.chat__cmd-item:hover { background: var(--ai-hover); }
.chat__cmd-item.active { background: var(--ai-active); }
.chat__cmd-cmd {
  flex: 0 1 auto; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; font-weight: 600;
  color: var(--ai-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat__cmd-name {
  flex: 1; min-width: 0;
  font-size: 12px; color: var(--ai-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat__cmd-hint {
  flex-shrink: 0; max-width: 40%;
  font-size: 10.5px; color: var(--ai-fg-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-left: auto;
  opacity: .8;
}
.chat__cmd-empty {
  padding: 18px 12px; text-align: center;
  color: var(--ai-fg-muted); font-size: 12px;
}

/* ========== Agent 选择下拉 (与 ModelPicker 风格统一) ========== */
.chat__agent-pop {
  position: absolute; bottom: calc(100% + 8px); left: 0;
  width: 320px; max-height: 380px; overflow-y: auto;
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 12px;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 12px 32px color-mix(in srgb, #000 40%, transparent);
  padding: 6px;
  z-index: 60;
}
.chat__agent-pop-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px 8px;
}
.chat__agent-pop-title { font-size: 12px; font-weight: 600; color: var(--ai-fg); }
.chat__agent-pop-close {
  width: 22px; height: 22px;
  background: transparent; border: none;
  color: var(--ai-fg-muted); font-size: 13px; line-height: 1;
  cursor: pointer; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 5px;
}
.chat__agent-pop-close:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__agent-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 9px 10px;
  background: transparent; border: none; border-radius: 8px;
  color: var(--ai-fg); font-family: inherit; text-align: left;
  cursor: pointer;
}
.chat__agent-item:hover { background: var(--ai-hover); }
.chat__agent-item.active { background: var(--ai-active); }
.chat__agent-item.active .chat__agent-name { color: var(--ai-fg); }
.chat__agent-icon {
  width: 28px; height: 28px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px;
  background: var(--ai-hover);
  border-radius: 7px;
}
.chat__agent-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.chat__agent-name { font-size: 12.5px; font-weight: 600; }
.chat__agent-desc { font-size: 11px; color: var(--ai-fg-muted); line-height: 1.4; }
.chat__agent-check { flex-shrink: 0; color: var(--ai-accent); display: inline-flex; }

/* ========== Tool call card (OpenCode style) ========== */
.tool {
  margin: 4px 0;
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 10px;
  overflow: hidden;
  min-width: 0;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 2px 8px color-mix(in srgb, #000 18%, transparent);
}
.tool__head {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 10px;
  background: transparent; border: none; cursor: pointer;
  color: var(--ai-fg); font-family: inherit; font-size: 12.5px;
  text-align: left;
  min-width: 0;
  transition: background .12s;
}
.tool__head:hover { background: var(--ai-hover); }
.tool.is-open > .tool__head { background: var(--ai-active); }
.tool__icon {
  width: 20px; height: 20px; border-radius: 5px;
  background: var(--ai-hover);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; flex-shrink: 0;
}
.tool.is-open > .tool__head .tool__icon { background: var(--ai-accent-soft); }
.tool__name {
  font-weight: 600; font-size: 12px;
  color: var(--ai-fg);
  flex-shrink: 0;
}
.tool__summary {
  flex: 1; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; color: var(--ai-fg-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 0 4px;
}
.tool__caret {
  color: var(--ai-fg-muted); font-size: 11px; flex-shrink: 0;
  padding: 0 6px; min-width: 14px; text-align: center;
  transition: transform .15s;
}
.tool.is-open > .tool__head .tool__caret { color: var(--ai-fg); }
.tool__body { padding: 0 10px 10px; min-width: 0; }
.tool__section {
  margin-top: 4px;
  min-width: 0;
  box-shadow: -2px 0 0 var(--ai-divider);
  padding-left: 10px;
}
.tool__section pre {
  margin: 0; padding: 8px 10px;
  background: var(--ai-bg); border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.6;
  max-width: 100%; min-width: 0;
  overflow-x: auto; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
  max-height: 260px;
}
.tool__section.is-error pre { color: var(--ai-danger); background: color-mix(in srgb, var(--ai-danger-bg) 30%, var(--ai-bg)); }

/* ========== Question card (OpenCode style) ========== */
.q {
  margin: 4px 0;
  background: var(--ai-input-bg);
  border: none;
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.q__head {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 10px;
  background: transparent; border: none; cursor: pointer;
  user-select: none; font-family: inherit;
  font-size: 12.5px; text-align: left;
}
.q__head:hover { background: var(--ai-hover); }
.q__caret {
  font-size: 10px; color: var(--ai-fg-muted); flex-shrink: 0;
  margin-left: auto;
}
.q__badge {
  font-size: 11px; color: var(--ai-fg-muted);
  display: inline-flex; align-items: center; justify-content: center;
}
.q__head-title { flex: 1; font-weight: 500; }
/* 多问题 tab: 单条不显示, 多条时显示可切换 */
.q__tabs { display: flex; gap: 3px; flex-shrink: 0; }
.q__tab {
  min-width: 24px; padding: 2px 7px;
  background: transparent; border: 1px solid transparent; border-radius: 5px;
  color: var(--ai-fg-muted); font-size: 11.5px; font-family: inherit;
  cursor: pointer; text-align: center;
}
.q__tab:hover { background: var(--ai-hover); color: var(--ai-fg); }
.q__tab.is-active {
  background: var(--ai-active); color: var(--ai-fg);
}
.q__summary {
  padding: 2px 10px 8px 26px;
  font-size: 12.5px; color: var(--ai-fg);
  line-height: 1.5;
}
.q.is-cancelled .q__summary { color: var(--ai-fg-muted); font-style: italic; }
.q__item { padding: 4px 10px 8px; }
.q__q {
  font-size: 13px; line-height: 1.5;
  margin-bottom: 6px;
}
.q__opts { display: flex; flex-direction: column; gap: 4px; }
.q__opt {
  display: flex; align-items: flex-start; gap: 8px;
  width: 100%; padding: 7px 10px;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  color: var(--ai-fg); font-family: inherit; font-size: 13px;
  cursor: pointer; text-align: left;
}
.q__opt:hover { background: var(--ai-input-bg); }
.q__opt.is-active { background: var(--ai-active); }
.q__opt-mark {
  flex-shrink: 0; font-size: 13px; line-height: 1.4;
  color: var(--ai-fg-muted);
}
.q__opt.is-active .q__opt-mark { color: var(--ai-accent); }
.q__opt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.q__opt-label { font-size: 13px; }
.q__opt-desc { font-size: 11.5px; color: var(--ai-fg-muted); line-height: 1.4; }
.q__custom {
  width: 100%; resize: none;
  background: transparent; border: none; outline: none;
  color: var(--ai-fg);
  font-family: inherit; font-size: 13px;
  padding: 2px 0;
}
.q__custom::placeholder { color: var(--ai-fg-muted); }
.q__custom-opt { cursor: text; }
.q__foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 0 10px 10px;
}
.q__foot-start { display: flex; gap: 8px; margin-right: auto; }
.q__foot-end { display: flex; gap: 8px; }
.q__nav {
  padding: 5px 14px; border-radius: 6px; cursor: pointer;
  background: transparent;
  color: var(--ai-fg);
  border: 1px solid var(--ai-border);
  font-size: 12px; font-weight: 500;
}
.q__nav:hover { background: var(--ai-hover); }
.q__submit {
  padding: 5px 14px; border-radius: 6px; cursor: pointer;
  background: var(--ai-hover);
  color: var(--ai-fg);
  border: none;
  font-size: 12px; font-weight: 500;
}
.q__submit:hover { background: var(--ai-hover); }
.q__submit:disabled { opacity: 0.5; cursor: default; }
.q--waiting {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  color: var(--ai-fg-muted);
  font-size: 12.5px;
}

/* ========== Question modal (dock above composer) ========== */
.chat__qmodal {
  margin-bottom: 8px;
  background: var(--ai-input-bg);
  border: none;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
}
.chat__qmodal-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  box-shadow: 0 1px 0 var(--ai-divider);
  cursor: pointer; user-select: none;
  background: transparent; border: none; width: 100%; font-family: inherit; text-align: left;
}
.chat__qmodal-head:hover { background: var(--ai-hover); }
.chat__qmodal-caret {
  font-size: 10px; color: var(--ai-fg-muted); flex-shrink: 0;
}
.chat__qmodal-count { font-size: 12px; font-weight: 500; }
.chat__qmodal-tabs { display: flex; gap: 4px; flex: 1; }
.chat__qmodal-tab {
  padding: 3px 10px;
  background: transparent; border: none; border-radius: 5px;
  color: var(--ai-fg-muted); font-size: 11.5px;
  cursor: pointer;
}
.chat__qmodal-tab:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__qmodal-tab.is-active {
  background: var(--ai-active); color: var(--ai-fg);
}
.chat__qmodal-min {
  width: 24px; height: 24px;
  background: transparent; border: none; border-radius: 5px;
  color: var(--ai-fg-muted); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.chat__qmodal-min:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__qmodal-body { padding: 10px 12px; }
.chat__qmodal-q { font-size: 13px; line-height: 1.5; }
.chat__qmodal-hint { font-size: 11.5px; color: var(--ai-fg-muted); margin: 4px 0 8px; }
.chat__qmodal-opts { display: flex; flex-direction: column; gap: 4px; }
.chat__qmodal-opt {
  display: flex; align-items: flex-start; gap: 8px;
  width: 100%; padding: 8px 10px;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  color: var(--ai-fg); font-family: inherit; font-size: 13px;
  cursor: pointer; text-align: left;
}
.chat__qmodal-opt:hover { background: var(--ai-input-bg); }
.chat__qmodal-opt.is-active { background: var(--ai-active); }
.chat__qmodal-opt.is-custom { cursor: text; }
.chat__qmodal-radio {
  width: 15px; height: 15px; border-radius: 50%;
  border: 1.5px solid var(--descriptionForeground);
  flex-shrink: 0; margin-top: 1px;
  display: inline-flex; align-items: center; justify-content: center;
}
.chat__qmodal-opt.is-active .chat__qmodal-radio { border-color: var(--ai-accent); }
.chat__qmodal-radio-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: transparent;
}
.chat__qmodal-opt.is-active .chat__qmodal-radio-dot { background: var(--ai-accent); }
.chat__qmodal-opt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.chat__qmodal-opt-label { font-size: 13px; }
.chat__qmodal-opt-desc { font-size: 11.5px; color: var(--ai-fg-muted); line-height: 1.4; }
.chat__qmodal-opt textarea {
  width: 100%; resize: none;
  background: transparent; border: none; outline: none;
  color: var(--ai-fg);
  font-family: inherit; font-size: 13px;
  padding: 2px 0;
}
.chat__qmodal-opt textarea::placeholder { color: var(--ai-fg-muted); }
.chat__qmodal-foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 4px 12px 10px;
  border-top: none;
}
.chat__qmodal-foot-start { display: flex; gap: 8px; }
.chat__qmodal-foot-end { display: flex; gap: 8px; margin-left: auto; }
.chat__qmodal-btn {
  padding: 4px 10px; border-radius: 5px; cursor: pointer;
  background: transparent; border: none;
  color: var(--ai-fg-muted);
  font-size: 12px; font-weight: 500;
}
.chat__qmodal-btn:hover { background: var(--ai-hover); color: var(--ai-fg); }
.chat__qmodal-btn--primary {
  background: var(--ai-hover);
}
.chat__qmodal-btn--primary:hover { background: var(--ai-hover); }
.chat__qmodal-btn:disabled { opacity: 0.5; cursor: default; }

/* ========== Todo card (OpenCode style) ========== */
.todo {
  margin: 4px 0;
  background: var(--ai-input-bg);
  border: none;
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.todo__head {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 10px;
  background: transparent; border: none; cursor: pointer;
  color: var(--ai-fg); font-size: 12.5px; font-family: inherit;
  text-align: left; min-width: 0;
}
.todo__head:hover { background: var(--ai-hover); }
.todo.is-open > .todo__head { background: var(--ai-active); }
.todo__status {
  width: 20px; height: 20px; border-radius: 5px;
  background: var(--ai-hover);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; flex-shrink: 0;
  color: var(--ai-fg);
}
.todo__status--completed { color: var(--ai-success); }
.todo__status--cancelled { color: var(--ai-danger); }
.todo__title {
  font-weight: 600; font-size: 12px;
  color: var(--ai-fg); flex: 1; min-width: 0;
}
.todo__caret {
  color: var(--ai-fg-muted); font-size: 11px; flex-shrink: 0;
  padding: 0 4px; min-width: 14px; text-align: center;
}
.todo.is-open > .todo__head .todo__caret { color: var(--ai-fg); }
.todo__list {
  list-style: none; margin: 0; padding: 0 10px 8px;
}
.todo__item {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 4px 0 4px 28px;
  font-size: 12.5px; line-height: 1.5;
  color: var(--ai-fg);
}
.todo__item.is-completed,
.todo__item.is-cancelled {
  color: var(--ai-fg-muted);
  text-decoration: line-through;
  opacity: 0.7;
}
.todo__item.is-cancelled .todo__check { color: var(--ai-danger); }
.todo__item.is-in_progress { font-weight: 500; color: var(--ai-fg); }
.todo__check {
  flex-shrink: 0;
  margin-left: -22px;
  font-size: 12px;
  color: var(--ai-fg-muted);
}
.todo__item.is-completed .todo__check,
.todo__item.is-in_progress .todo__check { color: var(--ai-fg); }
.todo__content { flex: 1; min-width: 0; word-break: break-word; }
.todo__pri {
  flex-shrink: 0;
  font-size: 10px; font-weight: 600;
  padding: 1px 6px; border-radius: 4px;
  background: var(--ai-hover);
}
.todo__pri.is-high { color: var(--ai-danger); }
.todo__pri.is-low { color: var(--ai-fg-muted); }
.todo__icon { color: var(--ai-fg-muted); }
.todo__icon--spin { display: inline-block; animation: todoSpin 1s linear infinite; }
@keyframes todoSpin { to { transform: rotate(360deg); } }

/* ========== Reasoning (OpenCode style) ========== */
.reason {
  margin: 4px 0;
  background: var(--ai-input-bg);
  border: none;
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.reason__head {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 10px;
  background: transparent; border: none; cursor: pointer;
  color: var(--ai-fg-muted); font-family: inherit;
  font-size: 12.5px; text-align: left;
}
.reason__head:hover { background: var(--ai-input-bg); color: var(--ai-fg); }
.reason__icon {
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ai-fg-muted);
}
.reason__caret {
  margin-left: auto;
  color: var(--ai-fg-muted); font-size: 9px;
}
.reason__body {
  padding: 2px 10px 10px 30px;
}
.reason__body pre {
  margin: 0;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ai-fg-muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

/* Gate (logged out) */
.chat__gate {
  margin: auto; text-align: left;
  max-width: 340px; padding: 32px 20px;
  display: flex; flex-direction: column; gap: 14px;
  color: var(--ai-fg);
}
.chat__gate-logo {
  width: 64px; height: 64px; border-radius: 18px;
  background: var(--ai-metal-accent);
  color: var(--button-foreground, #fff);
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; font-weight: 700;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 10px 28px color-mix(in srgb, var(--ai-accent) 40%, transparent);
  text-shadow: 0 1px 2px color-mix(in srgb, #000 30%, transparent);
}
.chat__gate-title { margin: 0; font-size: 19px; font-weight: 600; line-height: 1.4; color: var(--ai-fg); }
.chat__gate-brand {
  background: linear-gradient(135deg, var(--ai-accent), var(--ai-accent));
  -webkit-background-clip: text; background-clip: text; color: var(--ai-accent);
}
.chat__gate-features { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.chat__gate-features li { display: flex; align-items: flex-start; gap: 10px; font-size: 12.5px; color: var(--ai-fg); line-height: 1.5; }
.chat__gate-features svg { color: var(--ai-fg); flex-shrink: 0; margin-top: 2px; }
.chat__gate-user {
  margin-top: 6px;
  font-size: 11.5px; color: var(--ai-fg-muted);
  padding-top: 12px; box-shadow: 0 -1px 0 var(--ai-divider);
}

/* Welcome */
.chat__welcome {
  margin: auto;
  text-align: center;
  max-width: 420px; padding: 32px 20px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.chat__welcome-logo {
  width: 60px; height: 60px; border-radius: 18px;
  background: var(--ai-metal-accent);
  color: var(--ai-accent-fg); font-size: 28px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 10px 28px color-mix(in srgb, var(--ai-accent) 40%, transparent);
  text-shadow: 0 1px 2px color-mix(in srgb, #000 30%, transparent);
}
.chat__welcome-title { margin: 6px 0 0; font-size: 17px; font-weight: 600; color: var(--ai-fg); }
.chat__welcome-sub { margin: 0 0 12px; font-size: 12.5px; color: var(--ai-fg-muted); }
.chat__welcome-agents {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%;
  margin-bottom: 12px;
}
.chat__agent-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  padding: 12px;
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 10px;
  color: var(--ai-fg); font-family: inherit;
  cursor: pointer; text-align: left;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 2px 8px color-mix(in srgb, #000 16%, transparent);
  transition: background .12s, box-shadow .12s;
}
.chat__agent-card:hover { background: var(--ai-hover); }
.chat__agent-card.is-active {
  background: var(--ai-active);
  border-color: var(--ai-accent);
}
.chat__agent-card-icon { font-size: 16px; }
.chat__agent-card-name { font-size: 13px; font-weight: 600; }
.chat__agent-card-desc { font-size: 10.5px; color: var(--ai-fg-muted); line-height: 1.4; }

.chat__welcome-suggest {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%;
}
.chat__suggest {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px;
  background: var(--ai-glass-bg);
  -webkit-backdrop-filter: var(--ai-glass-blur);
  backdrop-filter: var(--ai-glass-blur);
  border: none;
  border-radius: 10px;
  color: var(--ai-fg); font-family: inherit;
  cursor: pointer; text-align: left;
  box-shadow: 0 1px 0 var(--ai-metal-edge) inset, 0 2px 8px color-mix(in srgb, #000 16%, transparent);
}
.chat__suggest:hover { background: var(--ai-hover); }
.chat__suggest-icon { font-size: 16px; flex-shrink: 0; }
.chat__suggest-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.chat__suggest-title { font-size: 12px; font-weight: 500; }
.chat__suggest-desc { font-size: 10.5px; color: var(--ai-fg-muted); line-height: 1.4; }

`;
