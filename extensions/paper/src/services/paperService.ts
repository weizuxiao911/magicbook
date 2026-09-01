import { getPluginConfig } from './config'
import { requestJson } from './http'

export interface SavePaperPayload {
  name: string
  questions: unknown[]
}

interface SaveOrUpdateResponse {
  examCode: string
}

export async function savePaper(payload: SavePaperPayload) {
  const config = getPluginConfig()
  if (!config.api.communityBaseUrl || !config.scope.labCode) {
    throw new Error('请配置 config/.env 中 communityBaseUrl（由 APP_ENV 选择）并检查 scope.labCode')
  }

  const paper = await requestJson<SaveOrUpdateResponse>(`${config.api.communityBaseUrl}/exam/saveOrUpdate`, {
    method: 'POST',
    body: {
      labCode: config.scope.labCode,
      type: 'PAPER',
      name: payload.name,
      courseCode: config.scope.courseCode
    }
  })

  return requestJson(`${config.api.communityBaseUrl}/exam/question/batchSave`, {
    method: 'POST',
    body: {
      examCode: paper.examCode,
      questions: payload.questions
    }
  })
}
