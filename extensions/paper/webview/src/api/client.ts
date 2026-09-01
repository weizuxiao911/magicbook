import { isVscode, vscode } from './vscode'
import type { HostRpcRequest, HostRpcResponse, PaperUpdateMessage, PaperViewState } from '../types'

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
const listeners = new Set<(paperState: PaperViewState) => void>()

window.addEventListener('message', (event: MessageEvent<HostRpcResponse | PaperUpdateMessage>) => {
  const message = event.data

  if (message.type === 'rpc-response') {
    const handler = pending.get(message.requestId)
    if (!handler) return
    pending.delete(message.requestId)
    if (message.success) {
      handler.resolve(message.data)
    } else {
      handler.reject(new Error(message.error || '操作失败'))
    }
  }

  if (message.type === 'paper:update') {
    listeners.forEach((listener) => listener(message.data))
  }
})

export function getInitialPaper(): PaperViewState {
  // 优先消费扩展侧通过 __PAPER_INITIAL_STATE__ 注入的完整页面状态
  // 兜底返回空态，仅用于脱离扩展的纯前端 dev 调试
  const fallback: PaperViewState = {
    status: 'empty',
    title: '题目',
    description: '当前未注入试卷数据，可通过扩展或调试消息载入内容。'
  }
  return (window.__PAPER_INITIAL_STATE__ as PaperViewState | undefined) || fallback
}

export function onPaperUpdate(listener: (paperState: PaperViewState) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function requestHost<T>(action: HostRpcRequest['action'], payload: unknown) {
  if (!isVscode) {
    return new Promise<T>((resolve) => {
      window.setTimeout(() => {
        resolve({ ok: true, action } as T)
      }, 120)
    })
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const message: HostRpcRequest = {
    type: 'rpc-request',
    requestId,
    action,
    payload
  }

  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject
    })
    vscode.postMessage(message)
  })
}
