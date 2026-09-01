import { useCallback, useEffect, useState } from 'react'
import { CheckCircleFilled } from '@ant-design/icons'
import { message, Modal } from 'antd'
import { getInitialPaper, onPaperUpdate, requestHost } from './api/client'
import { isVscode } from './api/vscode'
import { PaperDetail } from './components/PaperDetail'
import type { PaperViewState } from './types'

export default function App() {
  const [paperState, setPaperState] = useState(() => getInitialPaper())
  const [loading, setLoading] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  useEffect(() => {
    return onPaperUpdate((nextPaperState) => {
      setPaperState(nextPaperState)
    })
  }, [messageApi])

  const handleShowInfo = useCallback((value: string) => {
    messageApi.destroy()
    messageApi.warning(value)
  }, [messageApi])

  function showSuccessConfirm(type: 'questionbank' | 'paper') {
    Modal.confirm({
      title: type === 'paper' ? '试题存入试卷库成功！' : '题目加入题库成功！',
      icon: <CheckCircleFilled style={{ color: 'rgb(114,194,64)' }} />,
      okText: '继续出题',
      centered: true,
      width: 400,
      cancelText: type === 'paper' ? '去试卷库看看' : '去题库看看',
      async onCancel() {
        await requestHost('open-community-page', { page: type === 'paper' ? 'paper' : 'questionbank' })
      }
    })
  }

  async function handleJoinQuestions(questions: unknown[]) {
    try {
      setLoading(true)
      await requestHost('join-question-bank', { questions })
      showSuccessConfirm('questionbank')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '加入题库失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleSavePaper(name: string, questions: unknown[]) {
    try {
      setLoading(true)
      await requestHost('save-paper', { name, questions })
      showSuccessConfirm('paper')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '存入试卷库失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleClosePanel() {
    try {
      await requestHost('close-panel', {})
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '关闭失败')
    }
  }

  return (
    <>
      {contextHolder}
      <PaperDetail
        paperState={paperState}
        loading={loading}
        onJoinQuestions={handleJoinQuestions}
        onSavePaper={handleSavePaper}
        onShowInfo={handleShowInfo}
        showClose={isVscode}
        onClose={handleClosePanel}
      />
    </>
  )
}
