import { getPluginConfig } from './config'

export interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
}

function buildHeaders(url: string, options: RequestOptions) {
  const config = getPluginConfig()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {})
  }

  if (!headers.token && config.auth.token) {
    headers.token = config.auth.token
  }

  if (!headers.sign && config.auth.sign) {
    headers.sign = config.auth.sign
  }

  if (!headers.partner && config.auth.partner) {
    headers.partner = config.auth.partner
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
