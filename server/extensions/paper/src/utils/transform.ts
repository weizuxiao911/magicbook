import MarkdownIt from 'markdown-it'

const md = new MarkdownIt()

export interface RadioQuestionData {
  id?: string
  type: 'radio'
  text: string
  options: Array<{ title: string; value: string }>
  answer: string
  difficulty?: string
  score?: number
}

export interface MultipleQuestionData {
  id?: string
  type: 'checkbox'
  text: string
  options: Array<{ title: string; value: string }>
  answer: string[]
  difficulty?: string
  score?: number
}

export interface AnswerQuestionData {
  id?: string
  type: 'answer'
  text: string
  answer: string
  difficulty?: string
  score?: number
}

export interface CompletionQuestionData {
  id?: string
  type: 'completion'
  text: string
  answerList: string[]
  difficulty?: string
  score?: number
}

export interface CcmQuestionData {
  id?: string
  type: 'ccm'
  topic: string
  content: string
  language: string
  initCode: string
  exampleList: Array<{ input: string; output: string }>
  testCaseList: Array<{ input: string; output: string }>
  answer?: string
  verifyMode?: string
  inputNum?: number
  difficulty?: string
  score?: number
}

export function radioFormat(data: RadioQuestionData, labCode: string) {
  return {
    id: data.id,
    type: data.type,
    answer: data.answer,
    topic: data.text.trim(),
    score: data.score,
    difficulty: data.difficulty,
    option: JSON.stringify(data.options.map((item) => ({ key: item.value, value: item.title }))),
    labCode
  }
}

export function checkboxFormat(data: MultipleQuestionData, labCode: string) {
  return {
    id: data.id,
    type: data.type,
    answer: data.answer.join(','),
    topic: data.text.trim(),
    score: data.score,
    difficulty: data.difficulty,
    option: JSON.stringify(data.options.map((item) => ({ key: item.value, value: item.title }))),
    labCode
  }
}

export function answerFormat(data: AnswerQuestionData, labCode: string) {
  return {
    id: data.id,
    type: data.type,
    answer: md.render(data.answer).trim(),
    topic: data.text.trim(),
    score: data.score,
    difficulty: data.difficulty,
    judgeMode: 'AI_AGENT',
    labCode
  }
}

export function completionFormat(data: CompletionQuestionData, labCode: string) {
  return {
    id: data.id,
    type: data.type,
    topic: data.text.trim(),
    score: data.score,
    difficulty: data.difficulty,
    answerOption: data.answerList.map((item) => ({ answer: item })),
    judgeMode: 'AI_AGENT',
    labCode
  }
}

export function ccmFormat(data: CcmQuestionData, labCode: string) {
  return {
    id: data.id,
    type: data.type,
    topic: data.topic.trim(),
    content: data.content.trim(),
    score: data.score,
    difficulty: data.difficulty,
    languages: [data.language],
    code: data.initCode,
    answer: data.answer,
    exampleList: data.exampleList,
    testCaseList: data.testCaseList,
    codeList: [
      {
        languageName: data.language,
        languageAlias: data.language,
        customCode: data.initCode
      }
    ],
    verifyMode: data.verifyMode,
    inputNum: data.inputNum,
    judgeMode: 'AI_AGENT',
    labCode
  }
}

export function normalizeQuestionForSave(data: unknown, labCode: string) {
  const question = data as { type?: string }

  switch (question?.type) {
    case 'radio':
      return radioFormat(data as RadioQuestionData, labCode)
    case 'checkbox':
      return checkboxFormat(data as MultipleQuestionData, labCode)
    case 'answer':
      return answerFormat(data as AnswerQuestionData, labCode)
    case 'completion':
      return completionFormat(data as CompletionQuestionData, labCode)
    case 'ccm':
      return ccmFormat(data as CcmQuestionData, labCode)
    default:
      return data
  }
}
