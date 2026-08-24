// 浏览器环境: 不 import node fs/path/yaml (避免 bundle 引入 node polyfill
// 导致 CodeBlitz worker-host br.join 报错); 本地配置文件不可读, 走默认配置

export interface PluginAuthConfig {
  token: string
  sign: string
  partner: string
}

export interface PluginScopeConfig {
  labCode: string
  courseCode: string
}

export interface PluginApiConfig {
  communityBaseUrl: string
  communityPageBaseUrl: string
  codeTestUrl: string
  codePlayerUrl: string
}

export interface PluginConfig {
  auth: PluginAuthConfig
  scope: PluginScopeConfig
  api: PluginApiConfig
}

const defaultConfig: PluginConfig = {
  auth: {
    token: '',
    sign: '',
    partner: ''
  },
  scope: {
    labCode: '',
    courseCode: ''
  },
  api: {
    communityBaseUrl: '',
    communityPageBaseUrl: '',
    codeTestUrl: '',
    codePlayerUrl: ''
  }
}

let resolvedConfigPath: string | undefined
let resolvedExtensionPath: string | undefined

export function initConfig(_extensionPath?: string) {
  // 浏览器环境: 本地 .env/config 文件不可读, 使用默认配置
  // (labCode/API 由 gateway 注入沙箱环境, 不走本地文件)
  resolvedExtensionPath = undefined
  resolvedConfigPath = undefined
}

function readString(source: Record<string, unknown> | undefined, key: string): string {
  if (!source) {
    return ''
  }
  const value = source[key]
  return value === undefined || value === null ? '' : String(value)
}

function resolveApiConfig(): PluginApiConfig | null {
  // 浏览器环境: 本地 yaml 配置不可读, 返回 null (走默认)
  return null
}

function loadConfig(): PluginConfig {
  if (!resolvedConfigPath) {
    return cloneDefaultConfig()
  }
  // 浏览器环境 resolvedConfigPath 恒为 undefined, 上面已返回默认;
  // 保留分支仅为 Node 端扩展性 (本地文件配置)
  return cloneDefaultConfig()
}

function cloneDefaultConfig(): PluginConfig {
  return {
    auth: { ...defaultConfig.auth },
    scope: { ...defaultConfig.scope },
    api: { ...defaultConfig.api }
  }
}

export function getEnvFilePath(): string | undefined {
  return resolvedConfigPath
}

export function getPluginConfig(): PluginConfig {
  try {
    return loadConfig()
  } catch {
    return cloneDefaultConfig()
  }
}
