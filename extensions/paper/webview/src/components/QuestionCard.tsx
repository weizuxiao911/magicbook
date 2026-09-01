import { memo, useCallback, useMemo } from 'react'
import {
  QuestionAnswer,
  QuestionCcm,
  QuestionCompletion,
  QuestionMultiple,
  QuestionRadio
} from 'cloudlab-ui'
import { EditOutlined, PlusCircleOutlined } from '@ant-design/icons'
import { Checkbox } from 'antd'
import type { PaperQuestion } from '../types'
import { IconLay } from './IconLay'

interface Props {
  questionId: string
  index: number
  checked: boolean
  disabled?: boolean
  question: PaperQuestion
  actionQuestion?: PaperQuestion
  onToggleCheck: (questionId: string, checked: boolean) => void
  onJoin: (question: PaperQuestion) => void
  onSyncContent: (questionId: string, value: unknown) => void
  onShowInfo: (message: string) => void
  onGoAnswer?: (question: PaperQuestion) => void
}

function buildElements(onJoin: () => void, onEdit: () => void, disabled = false) {
  return [
    <IconLay key="join" onClick={onJoin} tip="加入题库" disabled={disabled} icon={<PlusCircleOutlined style={{ fontSize: 16 }} />} />,
    <IconLay key="edit" onClick={onEdit} tip="编辑" disabled={disabled} icon={<EditOutlined style={{ fontSize: 16 }} />} />
  ]
}

function QuestionCardInner({ questionId, index, checked, disabled = false, question, actionQuestion, onToggleCheck, onJoin, onSyncContent, onShowInfo, onGoAnswer }: Props) {
  const effectiveQuestion = actionQuestion ?? question

  const handleToggleCheck = useCallback(
    (checkedValue: boolean) => {
      onToggleCheck(questionId, checkedValue)
    },
    [onToggleCheck, questionId]
  )

  const handleJoinClick = useCallback(() => {
    onJoin(effectiveQuestion)
  }, [effectiveQuestion, onJoin])

  const handleEditClick = useCallback(() => {
    onShowInfo('当前版本暂不支持直接编辑题目，请通过 AI 对话继续改题。')
  }, [onShowInfo])

  const handleSyncContent = useCallback(
    (value: unknown) => {
      onSyncContent(questionId, value)
    },
    [onSyncContent, questionId]
  )

  const handleGoAnswerClick = useCallback(() => {
    onGoAnswer?.(effectiveQuestion)
  }, [effectiveQuestion, onGoAnswer])

  const elementCheckbox = useMemo(
    () => (
      <Checkbox style={{ marginRight: 10 }} checked={checked} onChange={(event) => handleToggleCheck(event.target.checked)} />
    ),
    [checked, handleToggleCheck]
  )

  const elements = useMemo(() => buildElements(handleJoinClick, handleEditClick, disabled), [disabled, handleEditClick, handleJoinClick])

  switch (question.type) {
    case 'radio':
      return (
        <QuestionRadio
          scenario="write"
          content={question}
          index={index}
          disabled={false}
          elementCheckbox={elementCheckbox}
          elements={elements}
          returnContent={handleSyncContent}
        />
      )
    case 'checkbox':
      return (
        <QuestionMultiple
          scenario="write"
          content={question}
          index={index}
          elementCheckbox={elementCheckbox}
          elements={elements}
          returnContent={handleSyncContent}
        />
      )
    case 'answer':
      return (
        <QuestionAnswer
          scenario="write"
          content={question}
          index={index}
          elementCheckbox={elementCheckbox}
          elements={elements}
          returnContent={handleSyncContent}
        />
      )
    case 'completion':
      return (
        <QuestionCompletion
          scenario="write"
          content={question}
          index={index}
          scoreDisabled={true}
          elementCheckbox={elementCheckbox}
          elements={elements}
          returnContent={handleSyncContent}
        />
      )
    case 'ccm':
      return (
        <QuestionCcm
          scenario="write"
          content={question}
          index={index}
          elementCheckbox={elementCheckbox}
          elements={elements}
          onGoAnswer={handleGoAnswerClick}
          returnContent={handleSyncContent}
        />
      )
    default:
      return null
  }
}

export const QuestionCard = memo(QuestionCardInner)
