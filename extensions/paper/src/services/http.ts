import { getPluginConfig } from './config'
import { getCurrentSession } from './sessionProvider'

export interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
}

function buildHeaders(url: string, options: RequestOptions) {
  const config = getPluginConfig()
  const session = getCurrentSession()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {})
  }

  // session 为 null (loading / unauthenticated / standalone) → 不注入 auth headers.
  // 请求变匿名; 上层如需强制登录, 在调 requestJson 前自查 getCurrentSession() !== null.
  // session 字段全部 optional (源字段 `?:`), 仅在 session.<field> 存在时注入.
  if (session) {
    if (!headers.token && session.token) headers.token = session.token
    if (!headers.sign && session.sign) headers.sign = session.sign
    if (!headers.partner && session.partner) headers.partner = session.partner
  }

  const token = headers.token
  const hasTenantId = Object.prototype.hasOwnProperty.call(headers, 'tenantId')

  if (token && url.indexOf('api.github.com') === -1 && !headers.Authorization) {
    headers.Authorization = token
  }

  if (!hasTenantId && config.scope.labCode) {
    headers.tenantId = config.scope.labCode
  }

  return headers
}

export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: buildHeaders(url, options),
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : undefined

  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : `请求失败: ${response.status}`
    throw new Error(message)
  }

  return data as T
}
