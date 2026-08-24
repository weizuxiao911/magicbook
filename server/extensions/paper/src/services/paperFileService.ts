import type { PaperDetail, PaperQuestionBase, PaperViewState } from '../state/types'

/** 浏览器兼容 basename / 去扩展名 (代替 node:path) */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}

function stripExt(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(0, idx) : name
}

/**
 * 从原始文本解析试卷内容并构建页面状态。
 * 支持两种格式：
 *   1. 题目数组：[{ type, topic, score, ... }, ...]
 *   2. 逗号分隔的多个题目：{ type, topic, score, ... }, { type, topic, ... }, ...
 *      （自动兜底用 [] 包裹后解析，也支持单个对象 { ... }）
 * - 空内容、空数组统一返回 empty 状态
 * - 非法 JSON 返回 error 状态
 */
export function resolvePaperFromContent(filePath: string, raw: string): PaperViewState {
  const tabTitle = baseName(filePath)
  const displayTitle = stripExt(tabTitle)
  const trimmed = raw.trim()

  if (!trimmed) {
    return {
      status: 'empty',
      title: tabTitle,
      description: '当前试卷内容为空，请录入题目后再试。'
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    try {
      parsed = JSON.parse(`[${trimmed}]`)
    } catch {
      return {
        status: 'error',
        title: tabTitle,
        description: '试卷文件不是合法的 JSON，请检查逗号、引号和括号是否完整。',
        detail: '请将以上内容发给 AI 协助修正。'
      }
    }
  }

  let questions: PaperQuestionBase[]
  if (Array.isArray(parsed)) {
    questions = parsed
  } else if (parsed && typeof parsed === 'object') {
    questions = [parsed as PaperQuestionBase]
  } else {
    return {
      status: 'error',
      title: tabTitle,
      description: '试卷文件结构不正确，请使用题目数组或逗号分隔的多个题目对象。',
      detail: '请将以上内容发给 AI 协助修正。'
    }
  }

  questions = questions.filter((q) => q && typeof q === 'object' && Object.keys(q).length > 0)

  if (questions.length === 0) {
    return {
      status: 'empty',
      title: tabTitle,
      description: '当前试卷暂无题目，请录入至少一道题后再试。'
    }
  }

  const totalScore = questions.reduce((sum, item) => {
    const score = (item as { score?: unknown }).score
    return sum + (typeof score === 'number' && Number.isFinite(score) ? score : 0)
  }, 0)

  const paper: PaperDetail = {
    title: displayTitle,
    questions,
    totalScore,
    questionCount: questions.length
  }

  return {
    status: 'ready',
    title: tabTitle,
    paper
  }
}
