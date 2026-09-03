import { useCallback, useEffect, useRef, useState } from 'react';
import type { Row } from '../helpers';

export function useChatMessages(ai: any, sessionID: string, ready: boolean) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const sessionIDRef = useRef(sessionID);
  sessionIDRef.current = sessionID;

  const refreshTodosRef = useRef<(sid: string) => Promise<void>>(async () => {});

  const loadMessages = useCallback(async (sid?: string) => {
    if (!ai) { setRows([]); return; }
    const target = sid || sessionIDRef.current;
    if (!target) { setRows([]); return; }
    try {
      const msgs = await ai.listMessages(target);
      const rs: Row[] = (msgs || []).map((m: any) => {
        const info = m.info || m;
        return {
          id: info?.id || m.id,
          role: info?.role || m.role,
          parts: m.parts || info?.parts || [],
        };
      });
      setRows(rs);
      void refreshTodosRef.current(target);
    } catch { /* ignore */ }
  }, [ai]);

  // sessionID 变更时拉取消息
  useEffect(() => {
    if (sessionID) void loadMessages(sessionID);
    else setRows([]);
  }, [sessionID, loadMessages]);

  // busy 状态轮询拉取 (打字机式)
  useEffect(() => {
    if (!busy || !sessionID) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      await loadMessages(sessionID);
      if (!stopped) timer = setTimeout(tick, 500);
    };
    timer = setTimeout(tick, 500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [busy, sessionID, loadMessages]);

  return {
    rows, setRows, busy, setBusy,
    sessionIDRef,
    loadMessages,
  };
}