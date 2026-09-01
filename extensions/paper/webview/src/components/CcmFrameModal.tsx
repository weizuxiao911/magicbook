import { useCallback, useEffect, useRef, useState } from 'react'
import { Spin } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import postRobot from 'post-robot'
import type { CcmFrameSession } from '../types'
import './CcmFrameModal.css'

interface Props {
  session: CcmFrameSession
  onClose: () => void
  onError: (message: string) => void
}

export function CcmFrameView({ session, onClose, onError }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loading, setLoading] = useState(true)

  const sendPayload = useCallback(
    async (currentSession: CcmFrameSession) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow) {
        return
      }

      try {
        await postRobot.send(
          frameWindow,
          'send',
          {
            ...(currentSession.payload as Record<string, unknown>)
          }
        )
      } catch (error) {
        onError('编码测验题页面初始化失败，请退出当前页面后重试。')
      }
    },
    [onError]
  )

  const handleFrameLoad = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow) {
      return
    }

    setLoading(false)
    sendPayload(session)
  }, [sendPayload, session])

  useEffect(() => {
    const origin = new URL(session.url).origin

    const sendListener = postRobot.on(
      'send-ready',
      { domain: origin },
      () => {
        sendPayload(session)
      }
    )

    const readyListener = postRobot.on(
      'ccm-ready',
      { domain: origin },
      () => {
        sendPayload(session)
      }
    )

    const refreshListener = postRobot.on(
      'refresh',
      { domain: origin },
      async () => {
        setTimeout(() => {
          if (iframeRef.current?.contentWindow) {
            sendPayload(session)
          }
        }, 500)
      }
    )

    return () => {
      sendListener.cancel()
      readyListener.cancel()
      refreshListener.cancel()
    }
  }, [sendPayload, session])

  useEffect(() => {
    setLoading(true)
  }, [session])

  return (
    <div className="paperui-ccm-overlay">
      <div className="paperui-ccm-topbar">
        <button className="paperui-ccm-back" onClick={onClose}>
          <ArrowLeftOutlined style={{ fontSize: 16 }} />
          <span>返回</span>
        </button>
        <span className="paperui-ccm-title">编码测验题预览</span>
      </div>
      <div className="paperui-ccm-body">
        {loading && (
          <div className="paperui-ccm-loading">
            <Spin />
          </div>
        )}
        <iframe
          key={session.sessionKey}
          ref={iframeRef}
          className="paperui-ccm-frame"
          src={session.url}
          title={session.title}
          onLoad={handleFrameLoad}
        />
      </div>
    </div>
  )
}
