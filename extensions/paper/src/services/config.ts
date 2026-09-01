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

export const defaultConfig: PluginConfig = {
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

let activeConfig: PluginConfig = cloneDefaultConfig()

function cloneDefaultConfig(): PluginConfig {
  return {
    auth: { ...defaultConfig.auth },
    scope: { ...defaultConfig.scope },
    api: { ...defaultConfig.api }
  }
}

export function setPluginConfig(next: Partial<PluginConfig>): void {
  activeConfig = {
    auth: { ...activeConfig.auth, ...(next.auth ?? {}) },
    scope: { ...activeConfig.scope, ...(next.scope ?? {}) },
    api: { ...activeConfig.api, ...(next.api ?? {}) }
  }
}

export function getPluginConfig(): PluginConfig {
  return {
    auth: { ...activeConfig.auth },
    scope: { ...activeConfig.scope },
    api: { ...activeConfig.api }
  }
}

export function updateScopeLabCode(labCode: string): void {
  activeConfig = {
    ...activeConfig,
    scope: { ...activeConfig.scope, labCode }
  }
}