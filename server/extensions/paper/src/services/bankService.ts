import { getPluginConfig } from './config'
import { requestJson } from './http'

export interface SaveQuestionPayload {
  questions: unknown[]
}

export async function saveQuestion(payload: SaveQuestionPayload) {
  const config = getPluginConfig()
  if (!config.api.communityBaseUrl || !config.scope.labCode) {
    throw new Error('请配置 config/.env 中 communityBaseUrl（由 APP_ENV 选择）并检查 scope.labCode')
  }

  return requestJson(`${config.api.communityBaseUrl}/question/bank/batchSave`, {
    method: 'POST',
    body: {
      labCode: config.scope.labCode,
      questions: payload.questions,
      courseCode: config.scope.courseCode
    }
  })
}
