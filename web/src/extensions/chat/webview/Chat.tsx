import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { CommandService } from '@opensumi/ide-core-common';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';

import { FsToken, type IFileSystem } from '@/commands/fs';
import { appBaseUrl, effectiveCwd } from '@/service/env';

import {
  aiListAgents,
  aiListSkills,
  aiListSessions,
  aiSwitchAgent,
  aiCompactSession,
  aiReplyQuestion,
  aiRejectQuestion,
  aiReplyPermission,
  aiListModels,
  aiListProviders,
  aiGetConfig,
  getAiClient,
} from '@/extensions/chat/commands/api';
import { modelPrefs } from '@/extensions/chat/commands/modelPrefs';
import { PartRenderer } from './parts/PartRenderer';
import { PermissionModal } from './parts/PermissionModal';
import { ModelPicker } from './parts/ModelPicker';

import {
  Row, HIDDEN_AGENTS, AGENT_ICONS, AGENT_DESC, CLIENT_COMMANDS,
  extractText, formatDuration, bytesToBase64,
  getQuestionStore, subscribeQuestionChange, setQuestion, clearQuestion,
} from './helpers';
import { getBrand } from '../scheme';
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
  // busy 按会话管理: sid → 是否生成中; 渲染/发送时取当前会话
  const [busyBySession, setBusyBySession] = useState<Record<string, boolean>>({});
  const busy = !!busyBySession[sessionID];
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
  const [previewAttachment, setPreviewAttachment] = useState<{ name: string; path: string; dataUrl?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const FILE_TYPE_DIR = 2;
  const [error, setError] = useState('');
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
  // 可用态: 有 APP_CWD 才可用, 否则提示先选择工作目录
  const [usable, setUsable] = useState<boolean>(() => !!localStorage.getItem('APP_CWD'));
  useEffect(() => {
    const refresh = () => setUsable(!!localStorage.getItem('APP_CWD'));
    window.addEventListener('runtime-ready', refresh);
    return () => window.removeEventListener('runtime-ready', refresh);
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);

  // 全局 opencode 用户信息 (webapp 启动期挂载, 无独立登录逻辑)
  const globalUser = useMemo(() => {
    const rt = (window as any).__APP_OPENCODE_RUNTIME__;
    return rt ? { userId: rt.userId, tenantId: rt.tenantId, deployEnv: rt.deployEnv } : null;
  }, []);

// chat 可用性: appBaseUrl 已注入（agent runtime 就绪）即视为可用,
// 不强制创建 SDK client（opencode 服务未起时面板仍可用, 请求时再失败提示）.
  const client = (window as any).__APP_OPENCODE__;
  const isReady = () => {
    // 必须有 APP_CWD（已选工作目录）才可用
    const hasCwd = !!effectiveCwd();
    const base = appBaseUrl();
    if (base && hasCwd) {
      try { getAiClient(); } catch { /* client 创建失败不阻塞面板 */ }
    }
    return !!base && hasCwd;
  };
  useEffect(() => {
    const check = () => setReady(isReady());
    check();
    const id = window.setInterval(check, 1500);
    return () => window.clearInterval(id);
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
        || t.closest('.chat__agent-pop')
        || t.closest('[data-ai-pop="agents"]')
        || t.closest('[data-ai-pop="models"]')
        || t.closest('[data-ai-pop="sessions"]')) return;
      setShowAgents(false);
      setShowModels(false);
      setShowSessions(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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

  // sessionID 持久化到 sessionStorage (绑定 cwd: 切换工作目录后不复用旧 session)
  const SESSION_KEY = 'chat.sessionID.' + (localStorage.getItem('APP_CWD') || 'default').replace(/[^a-zA-Z0-9]/g, '_');
  // 仅启动时恢复一次上次会话. 注意: 不能依赖 sessionID 重跑 (restore 读 storage + write 写
  // storage 会形成 A↔B 乒乓 → applySessionToUI 反复 session.get → 请求洪流).
  useEffect(() => {
    if (!ready || !client) return;
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved && saved !== sessionID) { setSessionID(saved); return; }
    if (!saved && !sessionID) { void ensureDraft(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, client]);
  useEffect(() => {
    if (sessionID) sessionStorage.setItem(SESSION_KEY, sessionID);
  }, [sessionID]);

  // --- opencode SSE 事件流: 打字机式流式响应 (替代 500ms 轮询) ---
  // client.event.subscribe() → /global/event, 每个事件 { type, properties }.
  // 注意: 事件频发时严禁触发 HTTP (loadMessages), 否则请求洪流 → ERR_INSUFFICIENT_RESOURCES.
  // busy 状态对账: 用 GET /session/status 全量刷新 (事件流丢事件/切会话后校正)
  const refreshSessionStatuses = useCallback(async () => {
    const c = (window as any).__APP_OPENCODE__;
    if (!c) return;
    try {
      const res = await c.session.status();
      const map: Record<string, boolean> = {};
      const data = res?.data || {};
      for (const [sid, st] of Object.entries(data)) {
        map[sid] = (st as any)?.type === 'busy';
      }
      setBusyBySession(map);
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const upsertRow = (id: string, role: Row['role'], parts: any[], time?: { created?: number; completed?: number }) => {
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === id);
        if (idx < 0) return [...prev, { id, role, parts, time }];
        const next = [...prev];
        next[idx] = { ...next[idx], parts, ...(time ? { time } : {}) };
        return next;
      });
    };
    const run = async () => {
      try {
        const evt = await c.event.subscribe();
        for await (const ev of evt.stream) {
          if (stopped) break;
          const { type, properties } = ev || {};
          if (!type || !properties) continue;
          // busy 状态全局维护: status/idle 事件总是处理 (带 sessionID), 不参与当前会话过滤,
          // 否则切走期间到达的 idle 事件被丢弃 → 旧会话 busy 悬挂
          if (type === 'session.status') {
            const st = properties.status?.type;
            const ssid = properties.sessionID;
            if (ssid) {
              if (st === 'busy') setBusyBySession((prev) => ({ ...prev, [ssid]: true }));
              else if (st === 'idle') {
                setBusyBySession((prev) => ({ ...prev, [ssid]: false }));
                if (ssid === sessionIDRef.current) void loadMessages(ssid);
              }
            }
            continue;
          }
          if (type === 'session.idle') {
            const ssid = properties.sessionID;
            if (ssid) setBusyBySession((prev) => ({ ...prev, [ssid]: false }));
            continue;
          }
          // 只处理当前会话的事件
          if (properties.sessionID && properties.sessionID !== sessionIDRef.current) continue;
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
        }
      } catch (e) {
        // SSE 断开: 退化为慢轮询兜底
        console.warn('[chat] event stream closed, fallback poll:', e);
      }
      if (!stopped) {
        // 重连后对账 busy 状态 (事件可能丢失)
        void refreshSessionStatuses();
        reconnectTimer = setTimeout(() => { void run(); }, 3000);
      }
    };
    void run();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [ready, loadMessages, refreshSessionStatuses]);

  // busy 兜底看门狗: 事件流异常时防止 busy 卡死 (仅当前会话)
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => {
      setBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
    }, 120000);
    return () => clearTimeout(t);
  }, [busy, sessionID]);

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
        setBusyBySession((prev) => ({ ...prev, [sid]: false }));
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
    if (!t || busy || !client) return;
    const images = opts?.images || [];
    const files = opts?.files || [];
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
      if (sid) setBusyBySession((prev) => ({ ...prev, [sid]: true }));
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
      setBusyBySession((prev) => ({ ...prev, [sessionIDRef.current]: false }));
      setRows((prev) => prev.filter((r) => r.id !== localId));
      setInput(t);
      setApiError(e);
    }
  }, [busy, sessionID, currentAgent, currentModel, models, client, setApiError]);

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
    setBusyBySession((prev) => ({ ...prev, [target]: false }));
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
  }, [cleanupDraft, refreshSessionStatuses]);

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
        case 'model': {
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
        case 'skill': {
          setShowSkills(true);
          setShowModels(false);
          setShowAgents(false);
          setShowCommands(false);
          break;
        }
        case 'session': {
          setShowSessions(true);
          void loadSessions();
          setShowModels(false);
          setShowAgents(false);
          setShowCommands(false);
          setShowSkills(false);
          break;
        }
        case 'agent': {
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

  const applyMention = useCallback((m: { id: string; name: string; type: string }) => {
    const trigger = input.match(/[@#]\S*$/)?.[0]?.[0] || '@';
    // agent / 目录 / 文件: 统一补全 (目录也补全路径)
    const replaced = input.replace(/[@#]\S*$/, `${trigger}${m.name} `);
    setInput(replaced);
    setShowMentions(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }, [input]);

  const onSelectSkill = useCallback((s: { name: string; description?: string; location?: string }) => {
    const replaced = input.replace(/(?:^|\s)\/(\S*)$/, ` #${s.name} `);
    setInput(replaced);
    setShowSkills(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }, [input]);

  const onReplyQuestion = useCallback(async (sid: string, rid: string, answers: string[][]) => {
    await aiReplyQuestion(sid, rid, answers);
    if (sid) {
      try { await loadMessages(sid); } catch { /* ignore */ }
      // 已回答: 清 store, 避免 QRecord 重复提示待回答
      clearQuestion(sid);
    }
  }, [loadMessages]);

  const onReplyPermission = useCallback(async (permissionID: string, response: 'once' | 'always' | 'reject') => {
    try {
      await aiReplyPermission(sessionID, permissionID, response);
      const psid = sessionID;
      setInteractions((prev) => {
        const cur = prev[psid];
        if (!cur?.permission || cur.permission.id !== permissionID) return prev;
        const next = { ...cur }; delete next.permission;
        return { ...prev, [psid]: next };
      });
    } catch (e) { console.warn('[ai] reply permission:', e); }
  }, [sessionID]);

  const onIgnoreQuestion = useCallback(async (rid: string) => {
    try {
      await aiRejectQuestion(sessionID, rid);
      if (sessionID) { try { await loadMessages(sessionID); } catch { /* ignore */ } }
      // 忽略: 清 store 避免重复提示待回答
      clearQuestion(sessionID);
    } catch (e) { console.warn('[ai] reject question:', e); }
  }, [sessionID, loadMessages]);

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
    for (const f of Array.from(files)) {
      try {
        const buf = await f.arrayBuffer();
        const safe = f.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
        const path = `/${safe}`;
        await fs.write(path, { base64: bytesToBase64(new Uint8Array(buf)) });
        added.push({ name: f.name, path });
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
    for (const it of fileItems) {
      try {
        const f = it.getAsFile();
        if (!f) continue;
        // 文件名: 优先原始名, 无 type 时按 mime 推 ext
        const mime = f.type || 'application/octet-stream';
        const extFromMime = mime.split('/')[1] || '';
        const extFromName = (f.name?.split('.').pop() || '').toLowerCase();
        const ext = (extFromName && extFromName.length <= 5) ? extFromName
          : (extFromMime.split(';')[0].replace(/[^\w]/g, '') || 'bin');
        const safeBase = (f.name || `paste-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
          .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
        const name = /\.[a-z0-9]{1,5}$/i.test(safeBase) ? safeBase : `${safeBase}.${ext}`;
        const path = `/${name}`;
        const buf = new Uint8Array(await f.arrayBuffer());
        // 走 PTY shell 写文件 (service/fs.write → FsPty.exec → base64 写)
        await fs.write(path, { base64: bytesToBase64(buf) });
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
        added.push({ name: f.name || name, path, dataUrl });
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
          {getBrand() && <span className="chat__logo">{getBrand()!.logoChar}</span>}
          <span className="chat__brand-name">{
            (() => {
              if (!usable) return 'AI 助手';
              if (!sessionID) return '新会话';
              const t = currentTitle
                || sessions.find((s: any) => s.id === sessionID)?.title
                || '';
              return !t || /^New session\b/i.test(t) ? '新会话' : t;
            })()
          }</span>
        </div>
        {!usable ? null : (
          ready && (
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
          )
        )}
      </header>

      {ready && showSessions && (
        <Portal>
          <SessionsModal
            sessions={sessions}
            currentID={sessionID}
            onSelect={onSwitchSession}
            onDelete={onDeleteSession}
            onClose={() => setShowSessions(false)}
          />
        </Portal>
      )}

      {ready && showSkills && (
        <Portal>
          <SkillsModal
            skills={skills}
            onSelect={onSelectSkill}
            onClose={() => setShowSkills(false)}
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <div className="chat__preview-body">
                {previewAttachment.dataUrl ? (
                  <img src={previewAttachment.dataUrl} alt={previewAttachment.name} />
                ) : (
                  <div className="chat__preview-file">
                    <span className="chat__attach-ic chat__attach-ic--lg">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
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
        {!usable ? (
          <div className="chat__login-gate">
            <div className="chat__login-title">{getBrand()?.nameZh || 'AI 助手'}</div>
            <div className="chat__login-desc">请先在工作目录面板选择工作目录</div>
          </div>
        ) : !ready ? (
          <ConnectingView user={globalUser} />
        ) : rows.length === 0 ? (
          <WelcomeScreen
            onPick={(prompt) => { void sendPrompt(prompt); }}
          />
        ) : (
          rows.map((r) => (
            <MessageRow
              key={r.id}
              row={r}
              streaming={busy && r.role === 'assistant' && r.id === rows[rows.length - 1]?.id}
              done={!busy}
              sessionID={sessionID}
              onReplyQuestion={onReplyQuestion}
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

      {notice && (
        <div className="chat__notice">
          <span className="chat__notice-text">{notice}</span>
          <button onClick={() => setNotice('')}>×</button>
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

          <div className="chat__input-wrap">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.json,.js,.ts,.tsx,.py,.sh,.html,.css,.zip,.tar,.gz"
              style={{ display: 'none' }}
              onChange={(e) => { void onUploadFile(e.target.files); e.target.value = ''; }}
            />
            {attachments.length > 0 && (
              <div className="chat__attach">
                {attachments.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    className="chat__attach-card"
                    onClick={() => setPreviewAttachment(a)}
                    title="点击查看"
                  >
                    {a.dataUrl ? (
                      <img className="chat__attach-thumb" src={a.dataUrl} alt={a.name} />
                    ) : (
                      <span className="chat__attach-ic">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      </span>
                    )}
                    <span className="chat__attach-name">{a.name}</span>
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
            <textarea
              ref={taRef}
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder="Ask anything, / for commands, @ for context..."
              rows={1}
            />
            <div className="chat__input-bar">
              <button type="button" className="chat__bar-btn chat__bar-plus" title="上传附件" onClick={() => fileInputRef.current?.click()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>

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
                  <div className="chat__agent-pop">
                    <div className="chat__agent-pop-head">
                      <span className="chat__agent-pop-title">选择 Mode</span>
                      <button type="button" className="chat__agent-pop-close" onClick={() => setShowAgents(false)}>✕</button>
                    </div>
                    {visibleAgents.map((a: any) => {
                      const id = a.id || a.name;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`chat__agent-item${id === currentAgent ? ' is-active' : ''}`}
                          onClick={() => onSwitchAgent(id)}
                        >
                          <span className="chat__agent-icon">{AGENT_ICONS[id] || '✨'}</span>
                          <span className="chat__agent-body">
                            <span className="chat__agent-name">{a.name || id}</span>
                            <span className="chat__agent-desc">{a.description || AGENT_DESC[id] || ''}</span>
                          </span>
                          {id === currentAgent && (
                            <span className="chat__agent-check">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
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
                      }}
                      onClose={() => setShowModels(false)}
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
              ) : (
                <button
                  type="button"
                  className="chat__send"
                  onClick={onSend}
                  disabled={!input.trim()}
                  title="发送 (Enter)"
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