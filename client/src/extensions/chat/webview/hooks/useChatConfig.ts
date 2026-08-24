/**
 * chat 业务 hooks — extensions/chat/webview/hooks/
 *
 * 每个 hook 单一职责:
 * - useChatConfig: agents / models / providers / skills / commands 加载
 * - useChatSessions: 会话列表 + 切换/删除
 * - useChatMessages: 消息流 + SSE + questions store
 * - useChatTodos: 当前会话 todos
 * - useChatComposer: 输入/附件/弹层状态
 * - useChatNotices: error / notice (含5s自动消失)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  aiListAgents,
  aiListCommands,
  aiListModels,
  aiListProviders,
  aiListSkills,
} from '@/extensions/chat/commands/api';
import { HIDDEN_AGENTS } from '../helpers';

export function useChatConfig(ready: boolean) {
  const [agents, setAgents] = useState<any[]>([]);
  const [currentAgent, setCurrentAgent] = useState<string>('build');
  const [models, setModels] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [skills, setSkills] = useState<Array<{ name: string; description?: string; location?: string }>>([]);
  const [commands, setCommands] = useState<Array<{ name: string; description?: string; source?: string; template?: string; subtask?: boolean }>>([]);
  const [, setModelsRefresh] = useState(0);

  const attempt = useCallback(async () => {
    try {
      const list = await aiListAgents();
      setAgents(list || []);
      if (list?.length) {
        const first = list.find((a: any) => {
          const id = a.id || a.name;
          const mode = a.mode || a.data?.mode;
          return id && !HIDDEN_AGENTS.has(id) && (mode === 'primary' || mode === 'all');
        }) || list[0];
        setCurrentAgent((cur) => !list.find((a: any) => (a.id || a.name) === cur) ? (first.id || first.name) : cur);
      }
    } catch (e) { console.warn('[ai] load agents failed', e); return; }

    try {
      const m = await aiListModels();
      setModels(m || []);
    } catch (e) { console.warn('[ai] load models failed', e); }

    try { setProviders(await aiListProviders() || []); } catch (e) { console.warn('[ai] load providers failed', e); }
    try { setSkills(await aiListSkills() || []); } catch (e) { console.warn('[ai] load skills failed', e); }
    try { setCommands(await aiListCommands() || []); } catch (e) { console.warn('[ai] load commands failed', e); }
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wrap = async () => {
      if (cancelled) return;
      await attempt();
    };
    void wrap();
    const onSandboxReady = () => { if (timer) clearTimeout(timer); void wrap(); };
    window.addEventListener('chat:sandbox-ready', onSandboxReady);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('chat:sandbox-ready', onSandboxReady);
    };
  }, [ready, attempt]);

  // 监听 model prefs 变化 (e.g. ModelPicker 设置了默认)
  useEffect(() => {
    const onPrefs = () => setModelsRefresh((n) => n + 1);
    window.addEventListener('chat:ai-modelPrefs-changed', onPrefs);
    return () => window.removeEventListener('chat:ai-modelPrefs-changed', onPrefs);
  }, []);

  const onSwitchAgent = useCallback(async (agent: string) => {
    setCurrentAgent(agent);
  }, []);

  return {
    agents, currentAgent, setCurrentAgent,
    models, providers, skills, commands,
    onSwitchAgent,
    refresh: attempt,
  };
}