export interface PaperQuestionBase {
  id?: string
  type: string
  score?: number
  [key: string]: unknown
}

export interface PaperDetail {
  title: string
  questions: PaperQuestionBase[]
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
