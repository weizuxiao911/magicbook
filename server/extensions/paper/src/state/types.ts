export interface PaperQuestionBase {
  id?: string
  type: string
  score?: number
  [key: string]: unknown
}

export interface PaperDetail {
  title: string
  questions: PaperQuestionBase[]
  // 扩展侧读取 JSON 后统计得到的总分与题目数
  totalScore: number
  questionCount: number
}

export interface ReadyPaperState {
  status: 'ready'
  title: string
  paper: PaperDetail
}

export interface EmptyPaperState {
  status: 'empty'
  title: string
  description: string
}

export interface ErrorPaperState {
  status: 'error'
  title: string
  description: string
  detail?: string
}

export type PaperViewState = ReadyPaperState | EmptyPaperState | ErrorPaperState

export interface RpcRequestMessage {
  type: 'rpc-request'
  requestId: string
  action: 'join-question-bank' | 'save-paper' | 'open-community-page' | 'close-panel' | 'search-labs' | 'update-lab-code'
  payload: unknown
}

export interface RpcResponseMessage {
  type: 'rpc-response'
  requestId: string
  success: boolean
  data?: unknown
  error?: string
}

export interface PaperUpdateMessage {
  type: 'paper:update'
  data: PaperViewState
}
