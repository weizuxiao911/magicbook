import type { CcmFrameSession } from '../types'

interface WebviewRuntimeConfig {
  codeTestUrl: string
  codePlayerUrl: string
  labCode?: string
  communityBaseUrl?: string
}

declare global {
  interface Window {
    __WEBVIEW_RUNTIME_CONFIG__?: WebviewRuntimeConfig
  }
}

function getCcmConfig(): WebviewRuntimeConfig {
  const injected = window.__WEBVIEW_RUNTIME_CONFIG__
  return {
    codeTestUrl: injected?.codeTestUrl ?? '',
    codePlayerUrl: injected?.codePlayerUrl ?? ''
  }
}

export function getLabConfig(): string {
  return window.__WEBVIEW_RUNTIME_CONFIG__?.labCode ?? ''
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function openCcmAnswer(data: unknown, onError: (message: string) => void) {
  const question = (data ?? {}) as Record<string, any>
  const { codeTestUrl, codePlayerUrl } = getCcmConfig()

  if (!codeTestUrl || !codePlayerUrl) {
    onError('请配置 config/.env 中 codeTestUrl / codePlayerUrl（由 APP_ENV 选择）')
    return
  }

  const verifyMode = question?.verifyMode ?? ''
  const language = question?.language ?? ''
  const topic = question?.topic ?? ''
  const content = question?.content ?? ''

  if (verifyMode === 'INPUT_OUTPUT') {
    return {
      sessionKey: createSessionKey(),
      title: topic || '编码测验题预览',
      url: codeTestUrl,
      payload: {
        title: topic,
        content,
        initCode: question?.initCode ?? '',
        code: question?.initCode ?? '',
        lang: language,
        cases: Array.isArray(question?.exampleList) ? question.exampleList.map((item: any) => ({ output: item?.output, input: parseMaybeJson(item?.input) })) : [],
        submitCases: Array.isArray(question?.testCaseList) ? question.testCaseList.map((item: any) => ({ output: item?.output, input: parseMaybeJson(item?.input) })) : [],
        noSubmit: true
      }
    } satisfies CcmFrameSession
  }

  let code = question?.initCode ?? ''
  if (language === 'html') {
    try {
      const all = typeof code === 'string' ? JSON.parse(code) : code
      code = [all?.html ?? '', all?.css ?? '', all?.js ?? '']
    } catch {}
  }

  return {
    sessionKey: createSessionKey(),
    title: topic || '编码测验题预览',
    url: `${codePlayerUrl}/embedded`,
    payload: {
      title: topic,
      content,
      lang: language,
      code,
      aiEnabled: false,
      run: false,
      dark: true
    }
  } satisfies CcmFrameSession
}

function createSessionKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
