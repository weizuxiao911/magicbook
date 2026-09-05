import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { CommandService } from '@opensumi/ide-core-common';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';

import { FsToken, type IFileSystem } from '@/service/filesystem';

import {
  aiListAgents,
  aiListSkills,
  aiListSessions,
  aiSwitchAgent,
  aiCompactSession,
  aiReplyQuestion,
  aiReplyPermission,
  aiListModels,
  aiListProviders,
  aiGetConfig,
  isAiReady,
} from '@/extensions/chat/commands/api';
import { modelPrefs } from '@/extensions/chat/commands/modelPrefs';
import { getWorkspace, subscribeWorkspace } from '@/infra/url';
import { onEvent } from '@/service/event/eventBus';
import { PartRenderer } from './parts/PartRenderer';
import { PermissionModal } from './parts/PermissionModal';
import { ModelPicker } from './parts/ModelPicker';

import {
  Row, HIDDEN_AGENTS, AGENT_ICONS, AGENT_DESC, CLIENT_COMMANDS,
  extractText, formatDuration, bytesToBase64,
  getQuestionStore, subscribeQuestionChange, setQuestion, clearQuestion,
} from './helpers';
import { getBrand } from '../scheme';
import { registerChatPanelApi } from '../commands/chatApi';
import { styles } from './styles';
import { ConnectingView } from './components/ConnectingView';
import { WelcomeScreen } from './components/WelcomeScreen';
import { MessageRow } from './components/MessageRow';
import { SessionsModal } from './components/SessionsModal';
import { SkillsModal } from './components/SkillsModal';
import { Portal } from './parts/Portal';

function loadClientCmds() {
  return CLIENT_COMMANDS.map((c) => ({ cmd: c.cmd, name: c.desc, hint: c.hint || '', source: 'client-cmd' as const }));
}

/** 按 cwd 生成 sessionStorage key. 最后段的可读名 (raw, 任意 unicode) + 8位哈希防碰撞:
 *  - 保留 CJK 可读性 (浏览 sessionStorage 时一眼看出是哪个目录)
 *  - 哈希防同名目录 (如 ~/a 和 ~/b 但只是同名, 哈希区分) / 超长路径截断
 *  - 切工作目录后 key 变, 旧 session 不会跨目录复用, 避免 session.directory 跟当前 cwd 不一致. */
function sessionKeyFor(cwd: string): string {
  if (!cwd) return 'chat.sessionID.default';
  // djb2 哈希 (非加密, sessionStorage 标识够用, 32-bit → 8 位 hex)
  let hash = 5381;
  for (let i = 0; i < cwd.length; i++) {
    hash = ((hash << 5) + hash) + cwd.charCodeAt(i);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  // 最后一段做可读短名 (取 unicode 字符, 限 12 字符, 空白 trim)
  const lastSeg = (cwd.split('/').filter(Boolean).pop() || '').trim().slice(0, 12);
  // 不可见字符或空 fallback
  const readable = lastSeg.replace(/[\x00-\x1F\x7F]/g, '') || 'cwd';
  return `chat.sessionID.${readable}-${hex}`;
}

/** /session/status 会话状态 (与 opencode SessionStatus.Info 对齐):
 *  idle 不会出现在服务端返回里 (无条目即 idle), retry 带 attempt/message/next 细节供状态条渲染 */
type SessionStatusInfo =
  | { type: 'busy' }
  | { type: 'idle' }
  | {
      type: 'retry';
      attempt: number;
      message: string;
      next: number;
      action?: {
        reason: string;
        provider: string;
        title: string;
        message: string;
        label: string;
        link?: string;
      };
    };

/** busy 判定: retry 也算 busy — 服务端还在重试流程里 (未终止的 run), 不锁输入会撞 busy 报错 */
function isBusyStatus(st?: SessionStatusInfo): boolean {
  return !!st && (st.type === 'busy' || st.type === 'retry');
}

/** retry 状态条的 next 字段展示: 绝对时间戳 (epoch ms) → 本地 HH:MM 时钟.
 *  静态时间不随渲染变 (事件/对账刷新时会更新), 避免显示过时的相对倒计时 */
function formatStatusTime(nextMs: number): string {
  const d = new Date(nextMs);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 在用户工作目录创建会话（directory 从 SDK path.get 取, 确保会话归属 workspace） */
async function createSessionInWorkspace(client: any) {
  try {
    const { data } = await client.path.get();
    const directory = typeof data?.directory === 'string' ? data.directory : undefined;
    return await client.session.create(directory ? { location: { directory } } : {});
  } catch {
    return await client.session.create({});
  }
}

export const Chat: React.FC = () => {
  const layoutService = useInjectable<IMainLayoutService>(IMainLayoutService);
  const commandService = useInjectable<CommandService>(CommandService);
  const fs = useInjectable<IFileSystem>(FsToken);
  useEffect(() => {}, []);

  // 挂载后设置 right 面板默认宽度 396 (getTabbarHandler 需在 tabbar 渲染后, 带重试)
  useEffect(() => {
    let tries = 0;
    const apply = () => {
      const handler = layoutService.getTabbarHandler('chat-panel');
      if (handler) {
        // setSize 内部会 +barSize (tabbar 宽度), 这里减掉让实际宽度 = 396
        const bar = layoutService.getTabbarService(SlotLocation.right)?.getBarSize?.() ?? 0;
        handler.setSize(396 - bar);
        return true;
      }
      return false;
    };
    if (apply()) return;
    const timer = setInterval(() => {
      tries += 1;
      if (apply() || tries > 20) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sessionID, setSessionID] = useState<string>('');
  const sessionIDRef = useRef(sessionID);
  sessionIDRef.current = sessionID;
  const [sessions, setSessions] = useState<any[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [input, setInput] = useState('');
  // 会话状态按 sid 维护 (busy/retry/idle + retry 细节): SSE 事件即时更新 + 15s 对账全量校准;
  // 渲染/发送时取当前会话. retry 期间 isBusyStatus=true (锁发送/可停止) + 状态条展示原因
  const [statusBySession, setStatusBySession] = useState<Record<string, SessionStatusInfo>>({});
  const busy = isBusyStatus(statusBySession[sessionID]);
  // 当前会话完整状态 (retry 时驱动输入框上方的状态条)
  const curStatus = statusBySession[sessionID];
  const [agents, setAgents] = useState<any[]>([]);
  const [currentAgent, setCurrentAgent] = useState<string>('build');
  const [models, setModels] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [, setModelsRefresh] = useState(0);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [currentProvider, setCurrentProvider] = useState<string>('');
  const [currentTitle, setCurrentTitle] = useState<string>('');
  const [showSessions, setShowSessions] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [agentQuery, setAgentQuery] = useState('');
  const [agentActiveIndex, setAgentActiveIndex] = useState(0);
  const agentBodyRef = useRef<HTMLDivElement>(null);
  const [showModels, setShowModels] = useState(false);
  /** ModelPicker 初始视图: select=模型选择, providers=模型管理(/connect) */
  const [modelPickerView, setModelPickerView] = useState<'select' | 'providers'>('select');
  const [showCommands, setShowCommands] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState<Array<{ name: string; description?: string; location?: string }>>([]);
  const [, setQuestionRev] = useState(0);
  // 交互状态按会话管理: sid → { question?, permission? }; 渲染时取当前会话, 切换天然跟随
  const [interactions, setInteractions] = useState<Record<string, { question?: { requestID: string; questions: any[] }; permission?: any }>>({});
  useEffect(() => {
    const sub = () => setQuestionRev((n) => n + 1);
    const unsub = subscribeQuestionChange(sub);
    return unsub;
  }, []);
  const [attachments, setAttachments] = useState<Array<{ name: string; path: string; dataUrl?: string }>>([]);
  /** 上传进度: { '<path>': 0..1 } — 上传中显示进度条 */
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [previewAttachment, setPreviewAttachment] = useState<{ name: string; path: string; dataUrl?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const FILE_TYPE_DIR = 2;
  const [error, setError] = useState('');
  /** 会话级错误 (session.error 事件): 上游 502/限流等最终失败 → 显式错误条告知用户.
   *  与 setError (API 调用错误) 分开: 事件错误挂在会话上, 切会话/重试后清除 */
  const [sessionErrors, setSessionErrors] = useState<Record<string, { name?: string; message: string; at: number }>>({});
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  }, []);
  const setApiError = useCallback((e: any, ctx?: string) => {
    const tag = e?.data?._tag || e?.name || '';
    const msg = String(e?.data?.message || e?.message || e);
    const isServerError =
      tag === 'UnknownError' ||
      tag === 'ServerError' ||
      tag === 'ServiceUnavailableError' ||
      msg.includes('Unexpected server error') ||
      msg.toLowerCase().includes('not available') ||
      (typeof e?.status === 'number' && e.status >= 500) ||
      (e?.data?.service && typeof e.data.service === 'string');
    const text = ctx ? `${ctx}: ${msg}` : msg;
    if (isServerError) showNotice(text + ' (服务端异常, 可重试或新建会话)');
    else setError(text);
  }, [showNotice]);
  const [ready, setReady] = useState<boolean>(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);

  // 全局 opencode 用户信息 (webapp 启动期挂载, 无独立登录逻辑)
  const globalUser = useMemo(() => {
    const rt = (window as any).__APP_OPENCODE_RUNTIME__;
    return rt ? { userId: rt.userId, tenantId: rt.tenantId, deployEnv: rt.deployEnv } : null;
  }, []);

  // 工作空间状态 (供上传附件按钮 + @提及等使用, 切入口已上移到顶栏 logo 旁的全局按钮,
  // 通过 workspace:request-show 派发 → WorkspacePicker 居中模态)
  const [workspace, setWorkspace] = useState<string>(() => getWorkspace());
  useEffect(() => {
    const refresh = () => setWorkspace(getWorkspace());
    const unsub = subscribeWorkspace(refresh);
    window.addEventListener('storage', refresh);
    // runtime-ready 时再刷一次 (处理 chat mount 后才 setWorkspace / reload 时序)
    window.addEventListener('runtime-ready', refresh);
    return () => {
      unsub();
      window.removeEventListener('storage', refresh);
      window.removeEventListener('runtime-ready', refresh);
    };
  }, []);

  // chat 可用性: 只看 opencode SDK 是否已初始化 (agent runtime 派发 runtime-ready 后
  // 把 client 挂到 window.__APP_OPENCODE__). 不依赖 APP_CWD —— 选了工作目录只是影响
  // SDK 请求里的 x-opencode-directory header (工作目录一律来自 URL ?directory).
  const client = (window as any).__APP_OPENCODE__;
  const isReady = () => isAiReady();
  useEffect(() => {
    const check = () => setReady(isReady());
    check();
    const id = window.setInterval(check, 500);
    const onReady = () => check();
    window.addEventListener('runtime-ready', onReady);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('runtime-ready', onReady);
    };
  }, []);

  // 就绪后自动聚焦输入框
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => taRef.current?.focus(), 200);
    return () => clearTimeout(t);
  }, [ready]);

  // 草稿会话: 打开面板且无 sessionID 时自动建一个; 若一直没发消息, 切换/删除/卸载时清理, 避免空会话污染历史
  const draftRef = useRef<{ sid: string; used: boolean } | null>(null);
  const ensureDraft = useCallback(async () => {
    if (!client || sessionIDRef.current || draftRef.current) return;
    try {
      const res = await createSessionInWorkspace(client);
      const sid = res?.data?.id;
      if (sid) {
        draftRef.current = { sid, used: false };
        setSessionID(sid);
      }
    } catch { /* 忽略, 交给用户手动新建 */ }
  }, [client]);
  const cleanupDraft = useCallback(() => {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d || d.used) return;
    (client?.session.delete({ sessionID: d.sid }) as any)?.catch?.(() => {});
  }, [client]);
  useEffect(() => {
    return () => { cleanupDraft(); };
  }, [cleanupDraft]);

  // --- 配置加载 (agents/models/providers/skills/commands) ---
  const loadConfig = useCallback(async () => {
    if (!ready) return;
    try {
      const list = await aiListAgents();
      setAgents(list || []);
      if (list?.length) {
        const first = list.find((a: any) => {
          const id = a.id || a.name;
          const mode = a.mode || a.data?.mode;
          return id && !HIDDEN_AGENTS.has(id) && (mode === 'primary' || mode === 'all');
        }) || list[0];
        if (!list.find((a: any) => (a.id || a.name) === currentAgent)) {
          setCurrentAgent(first.id || first.name);
        }
      }
    } catch (e) { console.warn('[ai] load agents failed', e); return; }
    try {
      const m = await aiListModels();
      setModels(m || []);
      if (m?.length) {
        // 读 opencode 全局默认 model (用户在 ~/.config/opencode/opencode.json 的 "model" 字段)
        // 失败不致命, 走原 fallback
        let globalDefault = '';
        let globalDefaultProvider = '';
        try {
          const cfg = await aiGetConfig();
          const mid = (cfg.model || '').split('/').pop() || '';
          const pid = (cfg.model || '').split('/')[0] || '';
          if (mid) { globalDefault = mid; globalDefaultProvider = pid; }
        } catch { /* ignore */ }

        // 只在 currentModel 未设置 OR 不在 models 列表时才 fallback,
        // 避免覆盖 session sync (applySessionToUI) 写入的真实 model
        setCurrentModel((cur) => {
          if (cur && m.find((x: any) => x.id === cur)) return cur;
          const prefs = modelPrefs.get();
          // 1. modelPrefs.default (用户本地的 chat 默认)
          if (prefs.default) {
            const def = m.find((x: any) => x.id === prefs.default && x.providerID === prefs.defaultProvider);
            if (def) return def.id;
            const anyProvider = m.find((x: any) => x.id === prefs.default);
            if (anyProvider) return anyProvider.id;
          }
          // 2. opencode 全局 config.model (用户在 ~/.config/opencode/opencode.json 配的)
          if (globalDefault) {
            const def = m.find((x: any) => x.id === globalDefault && x.providerID === globalDefaultProvider);
            if (def) return def.id;
            const anyProvider = m.find((x: any) => x.id === globalDefault);
            if (anyProvider) return anyProvider.id;
          }
          // 3. 兜底: 列表第一个
          return m[0].id;
        });
        // 同步推导 currentProvider: 优先用 currentProvider 对应 model,
        // 否则回退到 default/defaultProvider 对应 model
        setCurrentProvider((curP) => {
          if (curP && m.find((x: any) => x.providerID === curP)) return curP;
          const prefs = modelPrefs.get();
          if (prefs.defaultProvider) {
            const def = m.find((x: any) => x.id === prefs.default && x.providerID === prefs.defaultProvider);
            if (def) return def.providerID;
          }
          if (globalDefaultProvider) {
            const def = m.find((x: any) => x.id === globalDefault && x.providerID === globalDefaultProvider);
            if (def) return def.providerID;
          }
          const target = prefs.default
            ? m.find((x: any) => x.id === prefs.default)
            : globalDefault
              ? m.find((x: any) => x.id === globalDefault)
              : m[0];
          return target?.providerID || curP;
        });
      }
    } catch (e) { console.warn('[ai] load models failed', e); }
    try { setProviders(await aiListProviders() || []); } catch (e) { console.warn('[ai] load providers failed', e); }
    try { setSkills(await aiListSkills() || []); } catch (e) { console.warn('[ai] load skills failed', e); }
  }, [ready, currentAgent]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wrap = async () => { if (!cancelled) await loadConfig(); };
    void wrap();
    const onRuntimeReady = () => { if (timer) clearTimeout(timer); void wrap(); };
    window.addEventListener('runtime-ready', onRuntimeReady);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('runtime-ready', onRuntimeReady);
    };
  }, [ready, loadConfig]);
  useEffect(() => {
    const onReveal = () => setTimeout(() => taRef.current?.focus(), 120);
    const onPrefs = () => setModelsRefresh((n) => n + 1);
    const onSelectSession = (e: Event) => {
      const id = (e as CustomEvent<{ sessionID?: string }>).detail?.sessionID;
      if (typeof id === 'string' && id) {
        if (draftRef.current?.sid !== id) cleanupDraft();
        setSessionID(id);
        setSessions((prev) => prev.slice());
        setTimeout(() => taRef.current?.focus(), 120);
      }
    };
    window.addEventListener('chat:ai-reveal', onReveal);
    window.addEventListener('chat:ai-modelPrefs-changed', onPrefs);
    window.addEventListener('chat:ai-select-session', onSelectSession);
    return () => {
      window.removeEventListener('chat:ai-reveal', onReveal);
      window.removeEventListener('chat:ai-modelPrefs-changed', onPrefs);
      window.removeEventListener('chat:ai-select-session', onSelectSession);
    };
  }, []);

  useEffect(() => {
    if (showModels) setTimeout(() => modelSearchRef.current?.focus(), 30);
  }, [showModels]);
  useEffect(() => {
    if (!showAgents && !showModels && !showSessions) return;    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.chat__mpop')
        || t.closest('.chat__modal')
        || t.closest('[data-ai-pop="agents"]')
        || t.closest('[data-ai-pop="models"]')
        || t.closest('[data-ai-pop="sessions"]')) return;
      setShowAgents(false);
      setShowModels(false);
      setShowSessions(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowAgents(false);
      setShowModels(false);
      setShowSessions(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showAgents, showModels, showSessions]);

  const loadSessions = useCallback(async () => {
    if (!client) return;
    try {
      const list = await aiListSessions();
      setSessions(Array.isArray(list) ? list : []);
    } catch { /* ignore */ }
  }, [client]);

  const loadMessages = useCallback(async (sid?: string) => {
    const target = sid || sessionIDRef.current;
    if (!target) { setRows([]); return; }
    if (!client) return;
    try {
      const res = await client.session.messages({ sessionID: target });
      const list = (res?.data?.data || res?.data?.messages || res?.data || []);
      const rs: Row[] = (Array.isArray(list) ? list : []).map((m: any) => ({
        id: m.info?.id || m.id,
        role: m.info?.role || m.role,
        parts: m.parts || m.info?.parts || [],
        time: m.info?.time || undefined,
      }));
      setRows(rs);
    } catch (e) { setApiError(e); }
  }, [client, setApiError]);

  useEffect(() => {
    if (sessionID) loadMessages(sessionID);
    else setRows([]);
  }, [sessionID, loadMessages]);

  // sessionID 持久化到 sessionStorage, 跟当前 APP_CWD 绑定.
  // 切工作目录后 reload, 旧 SESSION_KEY 读不到 → 触发 ensureDraft 建新 session (新 cwd 下)
  // 这保证 session 的 directory 字段永远跟当前 cwd 一致, pwd 等 shell 命令结果正确
  const SESSION_KEY = useMemo(() => sessionKeyFor(getWorkspace()), []);
  // 仅启动时恢复一次上次会话. 注意: 不能依赖 sessionID 重跑 (restore 读 storage + write 写
  // storage 会形成 A↔B 乒乓 → applySessionToUI 反复 session.get → 请求洪流).
  // 顺手清掉 4a0b040 之前的旧版 'chat.sessionID' (无 cwd 后缀) 残留
  useEffect(() => {
    if (!ready || !client) return;
    try { sessionStorage.removeItem('chat.sessionID'); } catch { /* */ }
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved && saved !== sessionID) { setSessionID(saved); return; }
    if (!saved && !sessionID) { void ensureDraft(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, client]);
  useEffect(() => {
    if (sessionID) sessionStorage.setItem(SESSION_KEY, sessionID);
  }, [sessionID]);

  // --- opencode SSE 事件流: 打字机式流式响应 (替代 500ms 轮询) ---
  // V2 SDK event.subscribe() → /api/event, 顶层 {id, type, data} 格式.
  // 注意: 事件频发时严禁触发 HTTP (loadMessages), 否则请求洪流 → ERR_INSUFFICIENT_RESOURCES.
  // busy 状态对账: 用 GET /session/status 全量刷新 (事件流丢事件/切会话后校正)
  const refreshSessionStatuses = useCallback(async () => {
    const c = (window as any).__APP_OPENCODE__;
    if (!c) return;
    try {
      const res = await c.session.status();
      const map: Record<string, SessionStatusInfo> = {};
      const data = res?.data || {};
      // 服务端只返回非 idle 会话 (idle 即无条目, 覆盖本地残留); retry 细节原样保留供状态条渲染
      for (const [sid, st] of Object.entries(data)) {
        const info = st as SessionStatusInfo;
        if (info?.type === 'busy' || info?.type === 'idle' || info?.type === 'retry') map[sid] = info;
      }
      setStatusBySession(map);
    } catch { /* ignore */ }
  }, []);

  // 全部从事件数据直接更新 rows; 只有 session idle 时才做一次最终同步.
  // 依赖 ready（agentUrl 就绪后为 true）: 首次渲染 client 可能未创建, ready 翻转时重跑订阅
  useEffect(() => {
    if (!ready) return;
    const c = (window as any).__APP_OPENCODE__;
    if (!c) return;
    // 订阅前先对账一次
    void refreshSessionStatuses();
    let stopped = false;
    const upsertRow = (id: string, role: Row['role'], parts: any[], time?: { created?: number; completed?: number }) => {
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === id);
        if (idx < 0) return [...prev, { id, role, parts, time }];
        const next = [...prev];
        next[idx] = { ...next[idx], parts, ...(time ? { time } : {}) };
        return next;
      });
    };
    /** 会话消息事件: 来自客户端消息总线 (service/event/eventBus.ts, 全客户端唯一
     *  /global/event SSE). 总线已把帧归一化为 {type, properties}; 下方处理逻辑原样保留. */
    const handleEvent = (ev: { type: string; properties: any; directory?: string }) => {
      if (stopped) return;
          const { type, properties, directory } = ev || ({} as any);
          if (!type || !properties) return;
          // busy 状态全局维护: status/idle 事件总是处理 (带 sessionID), 不参与当前会话过滤,
          // 否则切走期间到达的 idle 事件被丢弃 → 旧会话 busy 悬挂
          // /global/event 广播进程内所有工作区实例的事件 (信封 directory = 事件所属实例路径);
          // 其他目录会话的 status/idle 会污染本表 (对账只查当前实例 → 悬挂项永不清除) → 按 directory 过滤
          if (type === 'session.status' || type === 'session.idle') {
            const dir = typeof directory === 'string' ? directory.replace(/\/+$/, '') : '';
            const ws = getWorkspace().replace(/\/+$/, '');
            if (dir && ws && dir !== ws) return;
          }
          if (type === 'session.status') {
            const st = properties.status as SessionStatusInfo | undefined;
            const ssid = properties.sessionID;
            if (ssid && st) {
              if (st.type === 'idle') {
                setStatusBySession((prev) => ({ ...prev, [ssid]: { type: 'idle' } }));
                if (ssid === sessionIDRef.current) void loadMessages(ssid);
              } else {
                setStatusBySession((prev) => ({ ...prev, [ssid]: st }));
              }
            }
            return;
          }
          if (type === 'session.idle') {
            const ssid = properties.sessionID;
            if (ssid) setStatusBySession((prev) => ({ ...prev, [ssid]: { type: 'idle' } }));
            return;
          }
          // 只处理当前会话的事件
          if (properties.sessionID && properties.sessionID !== sessionIDRef.current) return;
          switch (type) {
            case 'message.part.updated': {
              // 按 part.id upsert 任意类型 part (text/reasoning/tool/step-start 等), 不丢非 text part
              const part = properties.part;
              if (!part?.messageID) break;
              setRows((prev) => {
                const idx = prev.findIndex((r) => r.id === part.messageID);
                if (idx < 0) {
                  return [...prev, { id: part.messageID, role: 'assistant', parts: [part] }];
                }
                const next = [...prev];
                const row = { ...next[idx] };
                const parts = row.parts || [];
                // 匹配: 同 id, 或本地占位 part (无 id 且同 type 同 text) → 替换, 避免 "你好你好" 重复
                const replaceIdx = parts.findIndex((p: any) =>
                  (p?.id && p.id === part.id)
                  || (!p?.id && p?.type === part.type && part.text != null && p.text === part.text)
                );
                row.parts = replaceIdx >= 0
                  ? parts.map((p: any, i: number) => (i === replaceIdx ? part : p))
                  : [...parts, part];
                next[idx] = row;
                return next;
              });
              break;
            }
            case 'message.part.delta': {
              // 流式增量: 把 delta 追加到对应 part 的文本, 实现逐字打字机效果
              const { messageID, partID, delta, field } = properties || {};
              if (!messageID || !partID || typeof delta !== 'string') break;
              setRows((prev) => {
                const idx = prev.findIndex((r) => r.id === messageID);
                if (idx < 0) return prev;
                const next = [...prev];
                const row = { ...next[idx] };
                const parts = row.parts || [];
                const partIdx = parts.findIndex((p: any) => p?.id === partID);
                if (partIdx < 0) {
                  // 没有对应 part, 创建一个 text part 用 delta 开始
                  row.parts = [...parts, { id: partID, type: 'text', text: delta }];
                } else {
                  const p = { ...parts[partIdx] };
                  if (field === 'text') {
                    p.text = (p.text || '') + delta;
                  }
                  row.parts = parts.map((x: any, i: number) => (i === partIdx ? p : x));
                }
                next[idx] = row;
                return next;
              });
              break;
            }
            case 'message.updated': {
              // 完整消息更新 (message.updated 可能不带 parts, 只在有 parts 时覆盖, 避免清空流式文本)
              const info = properties.info;
              if (!info?.id || !info.role) break;
              if (info.role === 'user') {
                // 本地占位行 → 换真实 id + 用真实 parts (若有); 避免本地占位 part 与服务端 part 叠加重复
                setRows((prev) => {
                  const hasLocal = prev.some((r) => String(r.id).startsWith('local-'));
                  if (hasLocal) {
                    return prev.map((r) => (String(r.id).startsWith('local-')
                      ? { id: info.id, role: 'user', parts: info.parts?.length ? info.parts : r.parts }
                      : r));
                  }
                  if (info.parts?.length) return [...prev, { id: info.id, role: 'user', parts: info.parts }];
                  return prev;
                });
              } else if (info.parts?.length) {
                upsertRow(info.id, info.role, info.parts, info.time);
              }
              break;
            }
            case 'message.removed': {
              const mid = properties.messageID;
              if (mid) setRows((prev) => prev.filter((r) => r.id !== mid));
              break;
            }
            case 'session.updated': {
              // AI 生成真实标题后同步更新 banner (占位标题仍显示"新会话")
              const info = properties.info;
              if (info?.id && info.id === sessionIDRef.current) {
                const t = info.title || '';
                setCurrentTitle(!t || /^New session\b/i.test(t) ? '新会话' : t);
              }
              break;
            }
            case 'session.error': {
              // 生成最终失败 (上游 502/限流/网络等, 服务端重试耗尽后发): 显式告知用户.
              // 用户主动停止 (abort) 也走 error 事件 (MessageAbortedError) → 静默, 不弹错误.
              const esid = properties.sessionID as string | undefined;
              const errObj: any = properties.error || {};
              const errName: string = typeof errObj?.name === 'string' ? errObj.name : '';
              const rawMsg: string = typeof errObj?.data?.message === 'string'
                ? errObj.data.message
                : (typeof errObj?.message === 'string' ? errObj.message : '');
              if (!esid) break;
              if (/abort/i.test(errName) || /AbortError|aborted|interrupt/i.test(rawMsg)) {
                setStatusBySession((prev) => ({ ...prev, [esid]: { type: 'idle' } }));
                break;
              }
              // 提炼可读消息: 截首行 + 限长 (上游 message 可能夹带完整 responseBody)
              const oneLine = rawMsg.split('\n').map((s: string) => s.trim()).filter(Boolean)[0] || '模型服务出错, 请稍后重试';
              const msg = oneLine.length > 220 ? oneLine.slice(0, 220) + '…' : oneLine;
              setSessionErrors((prev) => ({ ...prev, [esid]: { name: errName, message: msg, at: Date.now() } }));
              setStatusBySession((prev) => ({ ...prev, [esid]: { type: 'idle' } }));
              break;
            }
            case 'question.asked': {
              // A2UI 提问: 存 que_xxx (持久化, QuestionCard 用它取 requestID); 卡片在消息流内直接交互, 无弹窗
              const qid = properties.id;
              const qsid = properties.sessionID;
              if (qid && qsid) {
                setQuestion(qsid, { requestID: qid, questions: properties.questions || [] });
              }
              break;
            }
            case 'todo.updated': {
              // todo 进度已由消息列表 todo 卡片呈现, 无需额外状态
              break;
            }
            case 'permission.updated': {
              // 工具权限请求: 弹权限卡片 (once/always/reject) — 挂到对应会话
              if (properties?.id) {
                const psid = properties.sessionID || sessionIDRef.current;
                setInteractions((prev) => ({ ...prev, [psid]: { ...prev[psid], permission: properties } }));
              }
              break;
            }
            case 'permission.replied': {
              // 权限已回复 → 收起卡片
              const pid = properties?.permissionID;
              if (pid) {
                const psid = properties.sessionID || sessionIDRef.current;
                setInteractions((prev) => {
                  const cur = prev[psid];
                  if (!cur?.permission || cur.permission.id !== pid) return prev;
                  const next = { ...cur }; delete next.permission;
                  return { ...prev, [psid]: next };
                });
              }
              break;
            }
          }
    };
    // 订阅消息总线 (EventSource 自动重连由总线负责); busy 丢事件对账靠初始 + 15s 定时
    const off = onEvent(handleEvent);
    return () => {
      stopped = true;
      off();
    };
  }, [ready, loadMessages, refreshSessionStatuses]);

  // busy 状态只反映 server 真实状态 (事件流 busy/idle 事件 + 下方 15s 对账全量校准).
  // 历史版本曾有「120s 强制复位 busy」的假看门狗: 长任务 (>120s) 时 UI 周期性假空闲
  // (停止按钮消失/工具卡折叠成完成/可误发同会话消息) — 已删除, 不再凭空改 UI.
  // 事件流丢 idle 事件时由 15s 对账兜底; 对账失败保持现状 (诚实, 不假装空闲).

  // busy 定时对账: 每 15s 校准一次, 覆盖事件丢失/连接抖动
  useEffect(() => {
    const t = setInterval(() => { void refreshSessionStatuses(); }, 15000);
    return () => clearInterval(t);
  }, [refreshSessionStatuses]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    // 等 DOM 把消息 render 完, 再滚到底; React render 是异步的, 用 rAF + setTimeout
    // 双保险, 否则大消息列表 (1100+ 条) 时 scrollHeight 还没长好
    const scrollToBottom = () => { el.scrollTop = el.scrollHeight; };
    requestAnimationFrame(() => {
      requestAnimationFrame(scrollToBottom);
      setTimeout(scrollToBottom, 0);
      setTimeout(scrollToBottom, 100);
    });
  }, [rows, busy]);

  // 从 opencode session 同步 agent/model/title 到本地 UI state
  const applySessionToUI = useCallback((session: any) => {
    if (!session) return;
    if (session.agent) setCurrentAgent(session.agent);
    if (session.model?.id) setCurrentModel(session.model.id);
    if (session.model?.providerID) setCurrentProvider(session.model.providerID);
    // 占位标题 (opencode 默认 "New session - <ts>") 不显示, 用 "新会话"
    const t = session.title || '';
    setCurrentTitle(!t || /^New session\b/i.test(t) ? '新会话' : t);
  }, []);

  // 当前 session 变更 → fetch 一次 session.get 拉最新 agent/model
  useEffect(() => {
    if (!client || !sessionID) return;
    (async () => {
      try {
        const r = await client.session.get({ sessionID });
        applySessionToUI(r?.data);
      } catch { /* ignore */ }
    })();
  }, [client, sessionID, applySessionToUI]);

  const onNewSession = useCallback(async () => {
    if (!ready || !client) return;
    // 不 abort 当前会话: 允许多会话并行生成, 切回后事件流自动续播
    cleanupDraft();
    try {
      const res = await createSessionInWorkspace(client);
      const sid = res?.data?.id;
      if (sid) {
        sessionIDRef.current = sid;
        setSessionID(sid);
        setRows([]);
        setStatusBySession((prev) => ({ ...prev, [sid]: { type: 'idle' } }));
        setError('');
        setCurrentTitle('新会话');
        setShowSessions(false);
      }
    } catch (e) { setApiError(e); }
  }, [ready, client, cleanupDraft, setApiError]);

  const selectedModel = useMemo(() => {
    if (!currentModel) return null;
    // 同名 model 可能跨多个 provider (如 MiniMax-M3 在 3 家), 优先按 id+providerID 精确定位
    if (currentProvider) {
      const m = models.find((x: any) => x.id === currentModel && x.providerID === currentProvider);
      if (m) return m;
    }
    return models.find((m: any) => m.id === currentModel) || null;
  }, [models, currentModel, currentProvider]);
  const currentAgentInfo = useMemo(
    () => agents.find((a: any) => (a.id || a.name) === currentAgent),
    [agents, currentAgent]
  );
  const currentModelLabel = useMemo(() => {
    if (!selectedModel) return '';
    const name = selectedModel.name || selectedModel.id || '';
    const provider = providers.find((p: any) => p.id === selectedModel.providerID)?.name
      || selectedModel.providerName
      || selectedModel.providerID;
    return provider ? `${name} · ${provider}` : name;
  }, [selectedModel, providers]);

  const sendPrompt = useCallback(async (text: string, opts?: { files?: Array<{ name: string; path: string }>; images?: Array<{ name: string; path: string; dataUrl?: string }> }) => {
    const t = (text || '').trim();
    const images = opts?.images || [];
    const files = opts?.files || [];
    // 纯文件/图片 (无文字) 也允许发送
    if ((!t && !images.length && !files.length) || busy || !client) return;
    const attachNote = files.length
      ? '\n\n[已上传文件]\n' + files.map((a) => `- ${a.path}`).join('\n')
      : '';
    const fullText = t + attachNote;
    const localId = `local-${Date.now()}`;
    const localParts: any[] = [{ type: 'text', text: fullText }];
    if (images.length) {
      localParts.push(...images.map((a) => ({
        type: 'file',
        mime: (a.dataUrl!.split(',')[0].match(/data:([^;]+)/)?.[1] || 'image/png'),
        filename: a.name,
        url: a.dataUrl,
      })));
    }
    setRows((prev) => [...prev, { id: localId, role: 'user', parts: localParts }]);
    try {
      let sid = sessionIDRef.current;
      if (!sid) {
        const res = await createSessionInWorkspace(client);
        sid = res?.data?.id;
        if (sid) setSessionID(sid);
      }
      if (sid && draftRef.current?.sid === sid) draftRef.current.used = true;
      // 始终按 currentModel + currentProvider 拼 model: 优先用 models 列表里
      // (providerID, modelID) 复合 key 匹配, 找不到时回退到当前 modelID
      const model = currentModel
        ? (() => {
            const m = models.find((x: any) =>
              x.id === currentModel &&
              (!currentProvider || x.providerID === currentProvider)
            );
            return m
              ? { providerID: m.providerID, modelID: m.id }
              : { modelID: currentModel, ...(currentProvider ? { providerID: currentProvider } : {}) };
          })()
        : undefined;
      if (sid) setStatusBySession((prev) => ({ ...prev, [sid]: { type: 'busy' } }));
      // 新请求已发出 → 清除该会话历史错误 (重试/新问题都不该再残留旧错误条)
      if (sid) setSessionErrors((prev) => (prev[sid] ? { ...prev, [sid]: undefined as any } : prev));
      // promptAsync: fire-and-forget, 回复由 SSE 事件流 (message.part.updated) 打字机式渲染
      const parts: any[] = [{ type: 'text', text: fullText }];
      if (images.length) {
        parts.push(...images.map((a) => ({
          type: 'file',
          mime: (a.dataUrl!.split(',')[0].match(/data:([^;]+)/)?.[1] || 'image/png'),
          filename: a.name,
          url: a.dataUrl,
        })));
      }
      await client.session.promptAsync({
        sessionID: sid,
        agent: currentAgent,
        parts,
        ...(model ? { model } : {}),
      });
    } catch (e) {
      setStatusBySession((prev) => ({ ...prev, [sessionIDRef.current]: { type: 'idle' } }));
      setRows((prev) => prev.filter((r) => r.id !== localId));
      setInput(t);
      setApiError(e);
    }
  }, [busy, sessionID, currentAgent, currentModel, models, client, setApiError]);

  // 当前会话的生成错误 (session.error 事件渲染用)
  const curSessionError = sessionID ? sessionErrors[sessionID] : undefined;
  const clearSessionError = useCallback(() => {
    if (!sessionID) return;
    setSessionErrors((prev) => (prev[sessionID] ? { ...prev, [sessionID]: undefined as any } : prev));
  }, [sessionID]);

  /** 重试最后一条用户消息 (错误条"重试"按钮): 取 rows 最后一条真实 user 文本重发 */
  const retryLastPrompt = useCallback(async () => {
    if (!sessionID || !ready || !client) return;
    const lastUser = [...rows].reverse().find((r) => r.role === 'user' && !String(r.id).startsWith('local-'));
    const text = lastUser?.parts
      ?.map((p: any) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim();
    if (!text) return;
    clearSessionError();
    await sendPrompt(text);
  }, [sessionID, ready, client, rows, clearSessionError, sendPrompt]);

  const onSend = useCallback(async () => {
    setError('');
    setInput('');
    const imgs = attachments.filter((a) => a.dataUrl);
    const files = attachments.filter((a) => !a.dataUrl);
    setAttachments([]);
    await sendPrompt(input, { files, images: imgs });
  }, [input, attachments, sendPrompt]);

  const onAbort = useCallback(async (sid?: string) => {
    const target = sid || sessionID;
    if (!target || !client) return;
    try { await client.session.abort({ sessionID: target }); }
    catch (e) { console.warn('[ai] abort:', e); }
    // 乐观复位为 idle; 服务端随后会发真实终态 (若停在 retry 循环上, abort 打断后发 idle)
    setStatusBySession((prev) => ({ ...prev, [target]: { type: 'idle' } }));
    setInteractions((prev) => {
      const cur = prev[target];
      if (!cur) return prev;
      const next = { ...cur }; delete next.permission;
      return { ...prev, [target]: next };
    });
  }, [sessionID, client]);

  const onSwitchSession = useCallback((sid: string) => {
    if (draftRef.current?.sid !== sid) cleanupDraft();
    setSessionID(sid);
    sessionIDRef.current = sid;
    setShowSessions(false);
    setRows([]);
    // 切换后对账 busy (事件流可能有遗漏)
    void refreshSessionStatuses();
    // 切完会话回 input, 继续输入 (双 rAF 避开 React 提交 + Portal 卸载)
    requestAnimationFrame(() => requestAnimationFrame(() => taRef.current?.focus()));
  }, [cleanupDraft, refreshSessionStatuses]);

  // 注册 ChatPanelApi (供 PDF AI讲解等外部调 send 发消息; 卸载注销)
  useEffect(() => {
    registerChatPanelApi({
      newSession: () => { void onNewSession?.(); },
      sessions: () => { /* 历史会话弹窗由内部 UI 管理 */ },
      send: (text) => { void sendPrompt(text); },
      changeSession: (sid) => onSwitchSession(sid),
    });
    return () => registerChatPanelApi(null);
  }, [sendPrompt, onSwitchSession]);

  const onDeleteSession = useCallback(async (sid: string) => {
    if (!client) return;
    try {
      await client.session.delete({ sessionID: sid });
      if (draftRef.current?.sid === sid) draftRef.current = null;
      setSessions((prev) => prev.filter((s) => s.id !== sid));
      if (sid === sessionID) {
        sessionIDRef.current = '';
        setSessionID('');
        setRows([]);
        void ensureDraft();
      }
    } catch (e) { setApiError(e); }
  }, [client, sessionID, ensureDraft, setApiError]);

  const onSwitchAgent = useCallback(async (agent: string) => {
    setCurrentAgent(agent);
    setShowAgents(false);
    if (sessionID) {
      try { await aiSwitchAgent(sessionID, agent); } catch (e) { setApiError(e); }
    }
    // 选完 agent 回 input 继续输入 (双 rAF 避开 React 提交 + Portal 卸载)
    requestAnimationFrame(() => requestAnimationFrame(() => taRef.current?.focus()));
  }, [sessionID, setApiError]);

  const commandList = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ cmd: string; name: string; hint?: string; source: 'client-cmd' }> = [];
    for (const c of loadClientCmds()) {
      if (seen.has(c.cmd)) continue;
      seen.add(c.cmd);
      list.push({ cmd: c.cmd, name: c.name, hint: c.hint, source: 'client-cmd' });
    }
    return list;
  }, []);

  const visibleAgents = useMemo(
    () => agents.filter((a: any) => {
      const id = a.id || a.name;
      const mode = a.mode || a.data?.mode;
      return id && !HIDDEN_AGENTS.has(id) && mode === 'primary';
    }),
    [agents]
  );

  // 打开 mode 选择器时清空搜索框
  useEffect(() => {
    if (showAgents) {
      setAgentQuery('');
      setAgentActiveIndex(0);
    }
  }, [showAgents]);
  // 搜索过滤 agent (按 name + description 模糊匹配, 同 ModelPicker 风格)
  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    if (!q) return visibleAgents;
    return visibleAgents.filter((a: any) => {
      const id = a.id || a.name;
      const name = (a.name || id || '').toLowerCase();
      const desc = (a.description || AGENT_DESC[id] || '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [visibleAgents, agentQuery]);

  // agent 弹层 ↑↓ 键盘导航 + Enter 选中
  const handleAgentKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setShowAgents(false); return; }
    if (filteredAgents.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAgentActiveIndex((i) => (i + 1) % filteredAgents.length); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setAgentActiveIndex((i) => (i - 1 + filteredAgents.length) % filteredAgents.length); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const a = filteredAgents[agentActiveIndex];
      if (a) onSwitchAgent(a.id || a.name);
      return;
    }
  }, [filteredAgents, agentActiveIndex, onSwitchAgent]);

  // 搜索/列表变化重置高亮
  useEffect(() => { setAgentActiveIndex(0); }, [agentQuery]);

  // 高亮项跟随滚动
  useEffect(() => {
    if (!showAgents) return;
    const body = agentBodyRef.current;
    if (!body) return;
    const el = body.querySelector('.is-highlighted');
    if (!el) return;
    const bRect = body.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < bRect.top) body.scrollTop += eRect.top - bRect.top;
    else if (eRect.bottom > bRect.bottom) body.scrollTop += eRect.bottom - bRect.bottom;
  }, [agentActiveIndex, showAgents]);

  const filteredCommands = useMemo(() => {
    const q = input.match(/(?:^|\s)\/(\S*)$/)?.[1] || '';
    if (!q) return commandList;
    const qLower = q.toLowerCase();
    return commandList.filter((c) => c.cmd.toLowerCase().startsWith(qLower) || c.name.toLowerCase().includes(qLower));
  }, [commandList, input]);

  // @ 提及 = primary agent + 工作目录递归铺平的所有文件/目录
  // query 用于过滤; 遇到空格输入框自动关闭弹层
  const mentionQueryFilter = mentionQuery.toLowerCase();

  // 异步列某目录子项 (ide 相对路径)
  const loadMentionDir = useCallback(async (idePath: string) => {
    if (!fs?.list) return [];
    try {
      const entries = await fs.list(idePath);
      return (entries || []).filter((e: any) => e && e.name && e.name !== '.' && e.name !== '..');
    } catch {
      return [];
    }
  }, [fs]);

  // 递归铺平整个工作目录树 → 扁平列表 [{path, type, depth}]
  // 按层级 BFS 异步加载, 每层加载完追加显示
  const [mentionFiles, setMentionFiles] = useState<Array<{ path: string; type: 'file' | 'dir'; depth: number }>>([]);
  const [mentionLoading, setMentionLoading] = useState(false);

  useEffect(() => {
    if (!showMentions) return;
    let cancelled = false;
    setMentionLoading(true);
    setMentionFiles([]);
    const visited = new Set<string>();
    // 队列: {idePath, rel, depth}, 每层一起出队 → 同 depth 一起入队 = 逐层铺开
    let queue: Array<{ idePath: string; rel: string; depth: number }> = [{ idePath: '/', rel: '', depth: 0 }];
    (async () => {
      while (queue.length) {
        if (cancelled) return;
        const level = queue;
        queue = [];
        const nextQueue: Array<{ idePath: string; rel: string; depth: number }> = [];
        const out: Array<{ path: string; type: 'file' | 'dir'; depth: number }> = [];
        await Promise.all(level.map(async ({ idePath, rel, depth }) => {
          if (cancelled || visited.has(idePath)) return;
          visited.add(idePath);
          const list = await loadMentionDir(idePath);
          for (const e of list) {
            if (cancelled) return;
            const name = e.name;
            const isDir = e.type === 'directory';
            const childRel = rel ? `${rel}/${name}` : name;
            out.push({ path: childRel, type: isDir ? 'dir' as const : 'file' as const, depth });
            if (isDir) nextQueue.push({ idePath: `/${childRel}`, rel: childRel, depth: depth + 1 });
          }
        }));
        if (cancelled) return;
        // 本层目录项排前面 (保持树形视觉: 目录先于其子目录内的文件)
        out.sort((a, b) => (a.depth - b.depth) || (a.type === 'dir' && b.type !== 'dir' ? -1 : 1));
        setMentionFiles((prev) => [...prev, ...out]);
        queue = nextQueue;
      }
      if (!cancelled) setMentionLoading(false);
    })().catch(() => { if (!cancelled) setMentionLoading(false); });
    return () => { cancelled = true; };
  }, [showMentions, loadMentionDir]);

  const mentionList = useMemo(() => {
    const q = mentionQueryFilter;
    const agentItems: Array<{ id: string; name: string; type: 'agent'; hint?: string }> = visibleAgents
      .filter((a) => {
        const id = a.id || a.name;
        const name = a.name || id;
        return !q || name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
      })
      .map((a) => ({
        id: a.id || a.name,
        name: a.name || a.id,
        type: 'agent' as const,
        hint: AGENT_DESC[a.id || a.name] || (a as any).description,
      }));

    const pathItems: Array<{ id: string; name: string; type: 'file' | 'dir'; hint?: string; depth: number }> = mentionFiles
      .filter((f) => !q || f.path.toLowerCase().includes(q))
      .map((f) => ({
        id: f.path,
        name: f.path,
        type: f.type,
        hint: f.type === 'dir' ? '目录' : '文件',
        depth: f.depth,
      }));

    return [...agentItems, ...pathItems];
  }, [visibleAgents, mentionQueryFilter, mentionFiles]);

  const [cmdIndex, setCmdIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const cmdPopRef = useRef<HTMLDivElement>(null);
  const mentionPopRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setCmdIndex(0); }, [filteredCommands.length, input]);
  useEffect(() => { setMentionIndex(0); }, [mentionList.length, input]);

  // 命令/提及弹层: 高亮项跟随滚动进入视野
  useEffect(() => {
    const pop = cmdPopRef.current;
    const el = pop?.querySelector('.chat__cmd-item.active');
    if (!pop || !el) return;
    const pRect = pop.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < pRect.top) pop.scrollTop += eRect.top - pRect.top;
    else if (eRect.bottom > pRect.bottom) pop.scrollTop += eRect.bottom - pRect.bottom;
  }, [cmdIndex]);
  useEffect(() => {
    const pop = mentionPopRef.current;
    const el = pop?.querySelector('.chat__cmd-item.active');
    if (!pop || !el) return;
    const pRect = pop.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < pRect.top) pop.scrollTop += eRect.top - pRect.top;
    else if (eRect.bottom > pRect.bottom) pop.scrollTop += eRect.bottom - pRect.bottom;
  }, [mentionIndex]);

  const runClientCmd = useCallback(async (cmd: string) => {
    try {
      switch (cmd) {
        case 'models': {
          // TUI /models 同款: 唤起模型选择
          setModelPickerView('select');
          setShowModels(true);
          setShowAgents(false);
          setShowCommands(false);
          setShowSkills(false);
          break;
        }
        case 'connect': {
          // TUI /connect 同款: 唤起模型管理 (服务商列表)
          setModelPickerView('providers');
          setShowModels(true);
          setShowAgents(false);
          setShowCommands(false);
          setShowSkills(false);
          break;
        }
        case 'compact': {
          if (!sessionID) { setError('当前没有选中会话'); return; }
          try {
            await aiCompactSession(sessionID);
            showNotice('已发起压缩, 完成后会刷新消息');
            await loadMessages(sessionID);
          } catch {
            showNotice('服务端暂未支持压缩 (session.compact 在 opencode 1.18.18 尚未上线)');
          }
          break;
        }
        case 'new': {
          await onNewSession();
          break;
        }
        case 'skills': {
          setShowSkills(true);
          setShowModels(false);
          setShowAgents(false);
          setShowCommands(false);
          break;
        }
        case 'sessions': {
          setShowSessions(true);
          void loadSessions();
          setShowModels(false);
          setShowAgents(false);
          setShowCommands(false);
          setShowSkills(false);
          break;
        }
        case 'agents': {
          setShowAgents(true);
          setShowModels(false);
          setShowCommands(false);
          setShowSkills(false);
          break;
        }
        default: setError(`未知客户端命令: /${cmd}`);
      }
    } catch (e) { setError(`/${cmd} 失败: ${String((e as any)?.message || e)}`); }
  }, [sessionID, client, loadMessages, showNotice, onNewSession, loadSessions, setShowSessions, setShowSkills, setShowModels, setShowAgents, setShowCommands, setModelPickerView]);

  const applyCommand = useCallback(async (c: { cmd: string; name: string; hint?: string; source: 'client-cmd' }) => {
    setShowCommands(false);
    setInput('');
    await runClientCmd(c.cmd);
  }, [runClientCmd]);

  /** 选中 popover item 后, 替换 input + 聚焦 + 光标移到末尾.
   *  一次写完, 避免 setTimeout 0 在 Portal 点击后失效. */
  const focusAndMoveCaretToEnd = useCallback((value: string) => {
    const el = taRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    // 下一帧再设光标 (等 React 提交新 value 后)
    requestAnimationFrame(() => {
      const len = value.length;
      try { el.setSelectionRange(len, len); } catch { /* ignore */ }
    });
  }, []);

  const applyMention = useCallback((m: { id: string; name: string; type: string }) => {
    const trigger = input.match(/[@#]\S*$/)?.[0]?.[0] || '@';
    const replaced = input.replace(/[@#]\S*$/, `${trigger}${m.name} `);
    setInput(replaced);
    setShowMentions(false);
    focusAndMoveCaretToEnd(replaced);
  }, [input, focusAndMoveCaretToEnd]);

  const onSelectSkill = useCallback((s: { name: string; description?: string; location?: string }) => {
    const replaced = input.replace(/(?:^|\s)\/(\S*)$/, ` #${s.name} `);
    setInput(replaced);
    setShowSkills(false);
    focusAndMoveCaretToEnd(replaced);
  }, [input, focusAndMoveCaretToEnd]);

  const onReplyQuestion = useCallback(async (sid: string, rid: string, answers: string[][]) => {
    await aiReplyQuestion(sid, rid, answers);
    if (sid) {
      try { await loadMessages(sid); } catch { /* ignore */ }
      // 已回答: 清 store, 避免 QRecord 重复提示待回答
      clearQuestion(sid);
    }
  }, [loadMessages]);

  const onReplyPermission = useCallback(async (permissionID: string, response: 'once' | 'always' | 'reject') => {
    const sid = sessionID;
    try {
      if (response === 'reject') {
        // 拒绝 = abort 对话 (停止当前任务, 权限请求作废)
        try { await aiReplyPermission(sid, permissionID, 'reject'); } catch { /* ignore */ }
        await onAbort(sid);
        return;
      }
      await aiReplyPermission(sid, permissionID, response);
      const psid = sid;
      setInteractions((prev) => {
        const cur = prev[psid];
        if (!cur?.permission || cur.permission.id !== permissionID) return prev;
        const next = { ...cur }; delete next.permission;
        return { ...prev, [psid]: next };
      });
    } catch (e) { console.warn('[ai] reply permission:', e); }
  }, [sessionID, onAbort]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % filteredCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault(); applyCommand(filteredCommands[cmdIndex]); return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && e.shiftKey)) {
        e.preventDefault(); applyCommand(filteredCommands[cmdIndex]); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowCommands(false); return; }
    }
    if (showMentions && mentionList.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionList.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionList.length) % mentionList.length); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault(); applyMention(mentionList[mentionIndex]); return;
      }
      if (e.key === 'Tab') { e.preventDefault(); applyMention(mentionList[mentionIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowMentions(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault(); onSend();
    }
  }, [onSend, showCommands, showMentions, filteredCommands, mentionList, cmdIndex, mentionIndex, applyCommand, applyMention]);

  const onUploadFile = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return;
    if (!fs?.write) { setError('沙箱文件系统未就绪'); return; }
    const added: Array<{ name: string; path: string }> = [];
    const ts = Date.now();
    const rnd = Math.random().toString(36).slice(2, 8);
    let idx = 0;
    for (const f of Array.from(files)) {
      try {
        const buf = await f.arrayBuffer();
        // 路径: 原名-时间戳-随机-idx, 避免覆盖 (同名多次上传不盖)
        const ext = (f.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] || '').toLowerCase();
        const base = f.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 60);
        const safe = base || 'file';
        const path = `/${safe}-${ts}-${rnd}-${idx}${ext}`;
        idx++;
        // 上传时显示进度 (service/fs.write 按 4KB 分块回调 onProgress)
        setUploadProgress((p) => ({ ...p, [path]: 0 }));
        await fs.write(path, { base64: bytesToBase64(new Uint8Array(buf)) }, (done, total) => {
          setUploadProgress((p) => ({ ...p, [path]: done / total }));
        });
        setUploadProgress((p) => ({ ...p, [path]: 1 }));
        setTimeout(() => setUploadProgress((p) => { const { [path]: _, ...rest } = p; return rest; }), 1000);
        added.push({ name: path.replace(/^\//, ''), path });
      } catch (e) { setError(`上传 ${f.name} 失败: ${String((e as any)?.message || e)}`); }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
  }, [fs]);

  const onPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    // 接任意 kind==='file' (图片/视频/音频/任意文件), 不只图片
    // 纯文本/代码片段 (kind 不为 file) 走 textarea 默认行为
    const fileItems = items.filter((it) => it.kind === 'file');
    if (fileItems.length === 0) return;
    e.preventDefault();
    if (!fs?.write) { setError('沙箱文件系统未就绪'); return; }
    const added: Array<{ name: string; path: string; dataUrl?: string }> = [];
    const ts = Date.now();
    const rnd = Math.random().toString(36).slice(2, 8);
    let idx = 0;
    for (const it of fileItems) {
      try {
        const f = it.getAsFile();
        if (!f) continue;
        const mime = f.type || 'application/octet-stream';
        // 路径: 原名-时间戳-随机-idx 避免覆盖
        const ext = (f.name?.match(/\.[a-z0-9]{1,5}$/i)?.[0]
          || (mime.split('/')[1]?.split(';')[0].replace(/[^\w]/g, '') ? `.${mime.split('/')[1].split(';')[0].replace(/[^\w]/g, '')}` : '')).toLowerCase();
        const base = (f.name || 'paste')
          .replace(/\.[a-z0-9]{1,5}$/i, '')
          .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
          .slice(0, 60) || 'paste';
        const path = `/${base}-${ts}-${rnd}-${idx}${ext}`;
        idx++;
        const buf = new Uint8Array(await f.arrayBuffer());
        // 走 PTY shell 写文件 (service/fs.write → FsPty.exec → base64 写), 按 4KB 分块回调进度
        setUploadProgress((p) => ({ ...p, [path]: 0 }));
        await fs.write(path, { base64: bytesToBase64(buf) }, (done, total) => {
          setUploadProgress((p) => ({ ...p, [path]: done / total }));
        });
        setUploadProgress((p) => ({ ...p, [path]: 1 }));
        setTimeout(() => setUploadProgress((p) => { const { [path]: _, ...rest } = p; return rest; }), 1000);
        // 预览图: 图片类型才生成 dataUrl, 其它只显示图标
        let dataUrl: string | undefined;
        if (mime.startsWith('image/')) {
          dataUrl = await new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(f);
          });
        }
        added.push({ name: path.replace(/^\//, ''), path, dataUrl });
      } catch (err) { setError(`粘贴文件失败: ${String((err as any)?.message || err)}`); }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
  }, [fs]);

  const onInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const m = val.match(/(?:^|\s)([\/@#])(\S*)$/);
    if (m) {
      const [, trigger, q] = m;
      if (trigger === '/') {
        setShowCommands(true); setShowMentions(false); setShowModels(false); setShowAgents(false);
      } else if (trigger === '@') {
        setShowMentions(true); setMentionQuery(q || ''); setShowCommands(false); setShowModels(false); setShowAgents(false);
      }
    } else { setShowCommands(false); setShowMentions(false); }
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, []);

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const prefs = modelPrefs.get();
    let list = models
      .filter((m: any) => !prefs.hidden.includes(m.id))
      .filter((m: any) => {
        if (!q) return true;
        const mid = m.id || '';
        const pid = m.providerID || '';
        const name = m.name || '';
        return `${pid}/${mid} ${name}`.toLowerCase().includes(q);
      });
    list = list.map((m: any) => ({ ...m, name: prefs.customNames[m.id] || m.name }));
    if (prefs.order.length > 0) {
      const idx = new Map(prefs.order.map((id, i) => [id, i] as [string, number]));
      list = [...list].sort((a, b) => {
        const ai = idx.has(a.id) ? idx.get(a.id)! : 1e9;
        const bi = idx.has(b.id) ? idx.get(b.id)! : 1e9;
        return ai - bi;
      });
    }
    return list;
  }, [models, modelQuery, models]);

  return (
    <div className="chat">
      <style>{styles}</style>

      <header className="chat__topbar">
        <div className="chat__brand">
          {getBrand() && <span className="chat__logo">{getBrand()!.logo}</span>}
          <span className="chat__brand-name">{
            (() => {
              if (!ready) return 'AI 助手';
              if (!sessionID) return '新会话';
              const t = currentTitle
                || sessions.find((s: any) => s.id === sessionID)?.title
                || '';
              return !t || /^New session\b/i.test(t) ? '新会话' : t;
            })()
          }</span>
        </div>
        {ready && (
          <div className="chat__top-actions">
            <button
              data-ai-pop="sessions"
              className="chat__icon-btn"
              title="历史会话"
              onClick={() => { setShowSessions((v) => !v); if (!showSessions) loadSessions(); }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </button>
            <button className="chat__icon-btn" title="新会话" onClick={onNewSession}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>
          </div>
        )}
      </header>

      {ready && showSessions && (
        <Portal>
          <SessionsModal
            sessions={sessions}
            currentID={sessionID}
            onSelect={onSwitchSession}
            onDelete={onDeleteSession}
            onClose={() => {
              setShowSessions(false);
              requestAnimationFrame(() => requestAnimationFrame(() => taRef.current?.focus()));
            }}
          />
        </Portal>
      )}

      {ready && showSkills && (
        <Portal>
          <SkillsModal
            skills={skills}
            onSelect={onSelectSkill}
            onClose={() => {
              setShowSkills(false);
              requestAnimationFrame(() => requestAnimationFrame(() => taRef.current?.focus()));
            }}
          />
        </Portal>
      )}

      {previewAttachment && (
        <Portal>
          <div
            className="chat__modal-overlay"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setPreviewAttachment(null); }}
          >
            <div className="chat__preview" role="dialog" aria-modal="true">
              <div className="chat__preview-head">
                <span className="chat__preview-name">{previewAttachment.name}</span>
                <button type="button" className="chat__modal-back" title="关闭" onClick={() => setPreviewAttachment(null)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <div className="chat__preview-body">
                {previewAttachment.dataUrl ? (
                  <img src={previewAttachment.dataUrl} alt={previewAttachment.name} />
                ) : (
                  <div className="chat__preview-file">
                    <span className="chat__attach-ic chat__attach-ic--lg">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </span>
                    <span className="chat__preview-path">{previewAttachment.path}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}

      <div className="chat__messages" ref={scrollRef}>
        {!ready ? (
          <ConnectingView user={globalUser} />
        ) : rows.length === 0 ? (
          <WelcomeScreen
            onPick={(prompt) => { void sendPrompt(prompt); }}
          />
        ) : (
          rows.map((r) => (
            // 打字机动画只在真正流式输出时开; retry 退避等待期不假装在出字
            <MessageRow
              key={r.id}
              row={r}
              streaming={curStatus?.type === 'busy' && r.role === 'assistant' && r.id === rows[rows.length - 1]?.id}
              done={!busy}
              sessionID={sessionID}
              onReplyQuestion={onReplyQuestion}
              onAbortSession={onAbort}
              busy={busy}
            />
          ))
        )}
      </div>

      {error && (
        <div className="chat__error">
          <span className="chat__error-text">{error}</span>
          <button onClick={() => { setError(''); if (sessionID) loadMessages(sessionID); }}>重试</button>
        </div>
      )}

      {/* 会话生成错误条 (session.error 事件): 显式告知上游 502/限流等失败, 带重试/关闭 */}
      {curSessionError && (
        <div className="chat__error">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              AI 回复失败{curSessionError.name ? ` · ${curSessionError.name.replace(/Error$/, '')}` : ''}
            </div>
            <div style={{ opacity: 0.85, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
              {curSessionError.message}
            </div>
            <div style={{ opacity: 0.6, marginTop: 2, fontSize: 11 }}>
              可能是模型服务商过载或网络问题, 可稍后重试或切换模型
            </div>
          </div>
          <button onClick={() => retryLastPrompt()}>重试</button>
          <button onClick={() => clearSessionError()}>×</button>
        </div>
      )}

      {notice && (
        <div className="chat__notice">
          <span className="chat__notice-text">{notice}</span>
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}

      {/* 会话状态条: 只在非 busy/idle (retry 退避/限额) 时出现, 展示服务端原因.
          busy 由停止按钮 + 流式动画表达, idle 无文案, 均不占这块区域 */}
      {curStatus?.type === 'retry' && (
        <div className="chat__status">
          <svg className="chat__status-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <div className="chat__status-main">
            <div className="chat__status-title">
              {curStatus.action?.title || '正在自动重试'}
              <span className="chat__status-next">
                第 {curStatus.attempt} 次 · 下次 {formatStatusTime(curStatus.next)}
              </span>
            </div>
            <div className="chat__status-msg">
              {curStatus.action?.message || curStatus.message}
            </div>
          </div>
          {curStatus.action?.link && (
            <a className="chat__status-link" href={curStatus.action.link} target="_blank" rel="noreferrer">
              {curStatus.action.label || '查看详情'}
            </a>
          )}
        </div>
      )}

      {ready && (
        <div className="chat__composer">
          {(() => {
            const cur = interactions[sessionID] || {};
            return (
              <>
                {cur.permission && (
                  <PermissionModal
                    permission={cur.permission}
                    onReply={onReplyPermission}
                    onDismiss={() => {
                      setInteractions((prev) => {
                        const c = prev[sessionID];
                        if (!c) return prev;
                        const next = { ...c }; delete next.permission;
                        return { ...prev, [sessionID]: next };
                      });
                    }}
                  />
                )}
              </>
            );
          })()}
          {showCommands && (
            <div className="chat__cmd-pop" ref={cmdPopRef}>
              <div className="chat__cmd-list">
                {filteredCommands.map((c, i) => (
                  <button
                    key={c.cmd}
                    type="button"
                    className={`chat__cmd-item${i === cmdIndex ? ' active' : ''}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    onClick={() => applyCommand(c)}
                  >
                    <span className="chat__cmd-cmd">/{c.cmd}</span>
                    <span className="chat__cmd-name">{c.name}</span>
                    {c.hint && <span className="chat__cmd-hint">{c.hint}</span>}
                  </button>
                ))}
                {filteredCommands.length === 0 && (
                  <div className="chat__cmd-empty">无匹配命令</div>
                )}
              </div>
            </div>
          )}

          {showMentions && (
            <div className="chat__cmd-pop" ref={mentionPopRef}>
              <div className="chat__cmd-list">
                {mentionLoading && mentionList.length === 0 && (
                  <div className="chat__cmd-empty">加载文件树…</div>
                )}
                {!mentionLoading && mentionList.length === 0 && (
                  <div className="chat__cmd-empty">无匹配项</div>
                )}
                {mentionList.map((m, i) => {
                  return (
                  <button
                    key={`${m.type}-${m.id}`}
                    type="button"
                    className={`chat__cmd-item chat__cmd-item--mention${i === mentionIndex ? ' active' : ''}`}
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => applyMention(m)}
                  >
                    <span className="chat__cmd-cmd">
                      {m.type === 'agent' ? '@' : m.type === 'dir' ? '📁 ' : '📄 '}{m.name}
                    </span>
                    <span className="chat__cmd-hint">{m.hint || m.type}</span>
                  </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="chat__input-wrap"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={(e) => {
              e.preventDefault();
              const files = e.dataTransfer?.files;
              if (files && files.length) void onUploadFile(files);
            }}
          >
            <textarea
              ref={taRef}
              className="chat__input"
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder="输入/ 可以召唤魔法; 输入@ 可以选择智能体 🎉"
              rows={1}
            />
            {attachments.length > 0 && (
              <div className="chat__attach">
                {attachments.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`chat__attach-card${uploadProgress[a.path] !== undefined && uploadProgress[a.path] < 1 ? ' is-uploading' : ''}`}
                    onClick={() => setPreviewAttachment(a)}
                    title={uploadProgress[a.path] !== undefined && uploadProgress[a.path] < 1
                      ? `上传中 ${Math.round((uploadProgress[a.path] || 0) * 100)}%`
                      : '点击查看'}
                  >
                    {a.dataUrl ? (
                      <img className="chat__attach-thumb" src={a.dataUrl} alt={a.name} />
                    ) : (
                      <span className="chat__attach-ic">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      </span>
                    )}
                    <span className="chat__attach-name">{a.name}</span>
                    {uploadProgress[a.path] !== undefined && uploadProgress[a.path] < 1 && (
                      <span className="chat__attach-progress" title={`上传中 ${Math.round(uploadProgress[a.path] * 100)}%`}>
                        <span className="chat__attach-progress-bar" style={{ width: `${Math.round(uploadProgress[a.path] * 100)}%` }} />
                      </span>
                    )}
                    <span
                      role="button"
                      tabIndex={0}
                      className="chat__attach-x"
                      title="移除"
                      onClick={(e) => { e.stopPropagation(); setAttachments((prev) => prev.filter((_, j) => j !== i)); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setAttachments((prev) => prev.filter((_, j) => j !== i)); } }}
                    >×</span>
                  </button>
                ))}
              </div>
            )}
            <div className="chat__input-bar">
              {/* 上传附件: 用 File System Access API (localhost 支持) 绕开 CodeBlitz 对原生 file chooser 的拦截 */}
              {workspace && (
                <button
                  type="button"
                  className="chat__bar-btn chat__bar-plus"
                  title="上传附件"
                  onClick={async () => {
                    console.log('[chat] + clicked, try showOpenFilePicker');
                    try {
                      // @ts-ignore — showOpenFilePicker 在 TS 5 之前不一定有类型
                      const w: any = window;
                      if (typeof w.showOpenFilePicker === 'function') {
                        const handles = await w.showOpenFilePicker({ multiple: true });
                        const files = await Promise.all(handles.map((h: any) => h.getFile()));
                        const dt = new DataTransfer();
                        files.forEach((f: File) => dt.items.add(f));
                        await onUploadFile(dt.files);
                      } else {
                        // 兜底: 仍用原生 input click (在 CodeBlitz 容器内可能仍被拦)
                        let fb = document.getElementById('chat-file-input') as HTMLInputElement | null;
                        if (!fb) {
                          fb = document.createElement('input');
                          fb.type = 'file'; fb.multiple = true;
                          fb.id = 'chat-file-input';
                          fb.style.display = 'none';
                          fb.addEventListener('change', () => { void onUploadFile(fb!.files); fb!.value = ''; });
                          document.body.appendChild(fb);
                        }
                        fb.click();
                      }
                    } catch (e: any) { console.warn('[chat] picker error:', e?.message); }
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}

              {/* 3. Model 选择器 (居中模态, 跟 ModelPicker 风格) — 保持原位 */}

              <div className="chat__select">
                <button
                  data-ai-pop="agents"
                  type="button"
                  className="chat__bar-btn chat__bar-text"
                  onClick={() => { setShowAgents((v) => !v); setShowModels(false); }}
                >
                  <span>{currentAgentInfo?.name || currentAgent}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {showAgents && (
                  <Portal>
                    <div
                      className="chat__modal-overlay"
                      role="dialog"
                      aria-modal="true"
                      onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAgents(false); }}
                    >
                      <div className="chat__modal" style={{ width: 460, maxHeight: 'min(calc(100vh - 72px), 520px)' }}>
                        <div className="chat__modal-search" style={{ margin: '14px 14px 0', borderRadius: 10 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                          <input
                            autoFocus
                            type="text"
                            placeholder="选择Agent角色"
                            value={agentQuery}
                            onChange={(e) => setAgentQuery(e.target.value)}
                            onKeyDown={handleAgentKeyDown}
                          />
                        </div>
                        <div className="chat__modal-body" ref={agentBodyRef}>
                          {filteredAgents.length === 0 && (
                            <div className="chat__modal-empty">无匹配 agent</div>
                          )}
                          {filteredAgents.map((a: any, idx: number) => {
                            const id = a.id || a.name;
                            const isActive = id === currentAgent;
                            const highlighted = idx === agentActiveIndex;
                            const desc = a.description || AGENT_DESC[id] || '';
                            return (
                              <div
                                key={id}
                                role="button"
                                tabIndex={0}
                                className={`chat__modal-item${isActive ? ' is-active' : ''}${highlighted ? ' is-highlighted' : ''}`}
                                onClick={() => onSwitchAgent(id)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSwitchAgent(id); }}
                              >
                                <span className="chat__modal-item-emoji">{AGENT_ICONS[id] || '✨'}</span>
                                <span className="chat__modal-item-body">
                                  <span className="chat__modal-item-name">{a.name || id}</span>
                                  {desc && <span className="chat__modal-item-desc">{desc}</span>}
                                </span>
                                {isActive && <span className="chat__modal-tag">当前</span>}
                                {isActive && (
                                  <svg className="chat__modal-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ai-accent, #6366f1)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </Portal>
                )}
              </div>

              <div className="chat__select">
                <button
                  data-ai-pop="models"
                  type="button"
                  className="chat__bar-btn chat__bar-text"
                  onClick={() => { setModelPickerView('select'); setShowModels((v) => !v); setShowAgents(false); }}
                >
                  <svg className="chat__spark" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/>
                  </svg>
                  <span>{currentModelLabel}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {showModels && (
                  <Portal>
                    <ModelPicker
                      models={models}
                      currentModel={currentModel}
                      currentProvider={currentProvider}
                      initialView={modelPickerView}
                      onSelect={(id, providerID) => {
                        setCurrentModel(id);
                        setCurrentProvider(providerID);
                         modelPrefs.setDefault(id, providerID);
                         setShowModels(false);
                         // 选完模型回到 input, 光标放末尾继续输入
                         requestAnimationFrame(() => requestAnimationFrame(() => taRef.current?.focus()));
                       }}
                       onClose={() => {
                         setShowModels(false);
                         requestAnimationFrame(() => requestAnimationFrame(() => taRef.current?.focus()));
                       }}
                      onProvidersChanged={async () => {
                        try {
                          const m = await aiListModels();
                          setModels(m || []);
                          const ps = await aiListProviders();
                          setProviders(ps as any);
                        } catch (e) { console.warn('[ai] refresh after connect failed', e); }
                      }}
                    />
                  </Portal>
                )}
              </div>

              <div className="chat__bar-spacer" />

              {busy ? (
                <button type="button" className="chat__send chat__send--stop" onClick={() => onAbort()} title="停止">
                  <span className="chat__stop-square" />
                </button>
              ) : Object.keys(uploadProgress).length > 0 ? (
                <button
                  type="button"
                  className="chat__send chat__send--uploading"
                  disabled
                  title={`上传中 ${Object.keys(uploadProgress).length} 个文件`}
                >
                  <span className="chat__upload-spinner" />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat__send"
                  onClick={onSend}
                  disabled={!input.trim() && attachments.length === 0}
                  title={attachments.length && !input.trim() ? `发送 ${attachments.length} 个附件` : '发送 (Enter)'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};