import { Empty, Tooltip } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CcmFrameSession, PaperDetail as PaperDetailType, PaperViewState } from '../types'
import { QuestionCard } from './QuestionCard'
import { ActionBar } from './ActionBar'
import { SavePaperModal } from './SavePaperModal'
import { SelectLabModal } from './SelectLabModal'
import { CcmFrameView } from './CcmFrameModal'
import { getLabConfig, openCcmAnswer } from '../utils/ccm'
import { requestHost } from '../api/client'

function isSameQuestionSnapshot(prevValue: unknown, nextValue: Record<string, unknown>) {
  if (!prevValue || typeof prevValue !== 'object') {
    return false
  }

  try {
    return JSON.stringify(prevValue) === JSON.stringify(nextValue)
  } catch {
    return false
  }
}

interface Props {
  paperState: PaperViewState
  loading?: boolean
  onJoinQuestions: (questions: unknown[]) => Promise<void>
  onSavePaper: (name: string, questions: unknown[]) => Promise<void>
  onShowInfo: (message: string) => void
  showClose?: boolean
  onClose?: () => void
}

function getDisplayPaper(paperState: PaperViewState): PaperDetailType {
  if (paperState.status === 'ready') {
    return paperState.paper
  }

  return {
    title: paperState.title,
    questions: [],
    totalScore: 0,
    questionCount: 0
  }
}

export function PaperDetail({ paperState, loading = false, onJoinQuestions, onSavePaper, onShowInfo, showClose = false, onClose }: Props) {
  const paper = useMemo(() => getDisplayPaper(paperState), [paperState])
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [normalizedMap, setNormalizedMap] = useState<Record<string, unknown>>({})
  const [ccmSession, setCcmSession] = useState<CcmFrameSession | null>(null)
  const [selectLabOpen, setSelectLabOpen] = useState(false)
  const resolveSelectLabRef = useRef<((labCode: string | null) => void) | null>(null)
  const tempLabCodeRef = useRef<string>('')

  const configuredLabCode = getLabConfig()
  const effectiveLabCode = tempLabCodeRef.current || configuredLabCode

  const ensureLab = useCallback(async () => {
    if (effectiveLabCode) return effectiveLabCode
    return await new Promise<string | null>((resolve) => {
      resolveSelectLabRef.current = resolve
      setSelectLabOpen(true)
    })
  }, [effectiveLabCode])

  useEffect(() => {
    setCheckedIds([])
    setNormalizedMap({})
    setSaveOpen(false)
    setCcmSession(null)
  }, [paperState])

  // 优先消费扩展侧下发的统计值，缺失时本地兜底计算，避免 NaN
  const totalScore = useMemo(
    () =>
      typeof paper.totalScore === 'number'
        ? paper.totalScore
        : paper.questions.reduce((sum, item) => sum + (typeof item.score === 'number' ? item.score : 0), 0),
    [paper.totalScore, paper.questions]
  )

  const questionCount = typeof paper.questionCount === 'number' ? paper.questionCount : paper.questions.length

  const questionEntries = useMemo(
    () =>
      paper.questions.map((question, index) => {
        const id = question.id || `question-${index}`
        return { id, question }
      }),
    [paper.questions]
  )

  const selectedQuestions = questionEntries
    .filter((entry) => checkedIds.includes(entry.id))
    .map((entry) => normalizedMap[entry.id] ?? entry.question)

  const allQuestions = questionEntries.map((entry) => normalizedMap[entry.id] ?? entry.question)
  const allSelected = questionEntries.length > 0 && checkedIds.length === questionEntries.length
  const operationDisabled = paperState.status !== 'ready' || questionEntries.length === 0

  async function handleJoinAll() {
    const labCode = await ensureLab()
    if (!labCode) return
    await onJoinQuestions(allQuestions)
  }

  async function handleJoinSelected() {
    const labCode = await ensureLab()
    if (!labCode) return
    await onJoinQuestions(selectedQuestions)
  }

  async function handleSavePaper(name: string) {
    if (!name.trim()) {
      onShowInfo('请输入试卷名称。')
      return
    }

    try {
      setSaveLoading(true)
      await onSavePaper(name, allQuestions)
      setSaveOpen(false)
    } finally {
      setSaveLoading(false)
    }
  }

  const handleToggleCheck = useCallback((id: string, checked: boolean) => {
    setCheckedIds((current) => {
      if (checked) {
        return current.includes(id) ? current : [...current, id]
      }
      return current.filter((item) => item !== id)
    })
  }, [])

  function toggleAll(checked: boolean) {
    setCheckedIds(checked ? questionEntries.map((entry) => entry.id) : [])
  }

  const handleJoinSingle = useCallback(async (question: unknown) => {
    const labCode = await ensureLab()
    if (!labCode) return
    await onJoinQuestions([question])
  }, [onJoinQuestions])

  const handleOpenCcm = useCallback((question: unknown) => {
    const session = openCcmAnswer(question, onShowInfo)
    if (!session) {
      return
    }
    setCcmSession(session)
  }, [onShowInfo])

  const handleSyncContent = useCallback((questionId: string, value: unknown) => {
    const original = questionEntries.find((e) => e.id === questionId)?.question
    const nextQuestion = {
      ...original,
      ...(value as Record<string, unknown>),
      id: questionId
    }

    setNormalizedMap((current) => {
      if (isSameQuestionSnapshot(current[questionId], nextQuestion)) {
        return current
      }

      return {
        ...current,
        [questionId]: nextQuestion
      }
    })
  }, [questionEntries])

  const titleRef = useRef<HTMLDivElement>(null)
  const [titleTruncated, setTitleTruncated] = useState(false)

  useEffect(() => {
    const el = titleRef.current
    if (el) {
      setTitleTruncated(el.scrollWidth > el.clientWidth)
    }
  }, [paper.title])

  return (
    <div className="paper-page">
      <div className="paper-summary">
        <div>
          <Tooltip title={titleTruncated ? paper.title : undefined}>
            <div ref={titleRef} className="paper-title">{paper.title}</div>
          </Tooltip>
          <div className="paper-meta">
            总分 {totalScore} · 共 {questionCount} 道题
          </div>
        </div>
        <ActionBar
          hasSelection={selectedQuestions.length > 0}
          allSelected={allSelected}
          disabled={loading}
          operationDisabled={operationDisabled}
          onJoinAll={handleJoinAll}
          onJoinSelected={handleJoinSelected}
          onSavePaper={async () => {
            const labCode = await ensureLab()
            if (!labCode) return
            setSaveOpen(true)
          }}
          onToggleAll={toggleAll}
          showClose={showClose}
          onClose={onClose}
        />
      </div>

      <div className="paper-list">
        {paperState.status === 'ready' ? (
          questionEntries.map(({ question, id: questionId }, index) => {
            const actionQuestion = (normalizedMap[questionId] as typeof question | undefined) ?? question
            return (
              <QuestionCard
                key={questionId}
                questionId={questionId}
                index={index + 1}
                checked={checkedIds.includes(questionId)}
                disabled={loading}
                question={question}
                actionQuestion={actionQuestion}
                onToggleCheck={handleToggleCheck}
                onJoin={handleJoinSingle}
                onGoAnswer={handleOpenCcm}
                onShowInfo={onShowInfo}
                onSyncContent={handleSyncContent}
              />
            )
          })
        ) : (
          <div className="paper-state-card">
            {paperState.status === 'empty' ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span className="paper-state-description">{paperState.description}</span>}
              />
            ) : (
              <div className="paper-error-card">
                <div className="paper-error-icon">!</div>
                <div className="paper-error-title">试卷内容无法展示</div>
                <div className="paper-error-desc">{paperState.description}</div>
                {paperState.detail ? (
                  <div className="paper-error-hint">{paperState.detail}</div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>

      <SelectLabModal
        open={selectLabOpen}
        onCancel={() => {
          setSelectLabOpen(false)
          resolveSelectLabRef.current?.(null)
          resolveSelectLabRef.current = null
        }}
        onOk={async (code) => {
          await requestHost('update-lab-code', { labCode: code })
          tempLabCodeRef.current = code
          setSelectLabOpen(false)
          resolveSelectLabRef.current?.(code)
          resolveSelectLabRef.current = null
        }}
      />
      <SavePaperModal
        open={saveOpen}
        title={paper.title}
        loading={saveLoading}
        onCancel={() => setSaveOpen(false)}
        onConfirm={handleSavePaper}
      />
      {ccmSession && (
        <CcmFrameView
          session={ccmSession}
          onClose={() => setCcmSession(null)}
          onError={onShowInfo}
        />
      )}
    </div>
  )
}
