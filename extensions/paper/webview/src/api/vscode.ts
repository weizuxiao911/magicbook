type VscodeApi = {
  postMessage: (message: unknown) => void
  setState?: (state: unknown) => void
  getState?: () => unknown
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VscodeApi
    __PAPER_INITIAL_STATE__?: unknown
  }
}

const fallbackApi: VscodeApi = {
  postMessage: (message) => {
    console.log('postMessage fallback', message)
  }
}

export const isVscode = typeof window.acquireVsCodeApi === 'function'

export const vscode = isVscode
  ? window.acquireVsCodeApi!()
  : fallbackApi
