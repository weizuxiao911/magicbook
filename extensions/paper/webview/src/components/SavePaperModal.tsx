import { useEffect, useState } from 'react'
import { Button, Input, Modal } from 'antd'

interface Props {
  open: boolean
  title: string
  loading?: boolean
  onCancel: () => void
  onConfirm: (value: string) => void
}

export function SavePaperModal({ open, title, loading = false, onCancel, onConfirm }: Props) {
  const [value, setValue] = useState(title)

  useEffect(() => {
    if (open) {
      setValue(title)
    }
  }, [open, title])

  if (!open) {
    return null
  }

  return (
    <Modal
      open={open}
      title="存入试卷库"
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={loading}>
          取消
        </Button>,
        <Button
          key="confirm"
          type="primary"
          loading={loading}
          disabled={!value.trim()}
          onClick={() => onConfirm(value.trim())}
        >
          确认
        </Button>
      ]}
      className="paperui-title-modal"
      destroyOnHidden
    >
      <label className="modal-label" htmlFor="paper-title">
        试卷名称
      </label>
      <Input
        id="paper-title"
        value={value}
        maxLength={30}
        onChange={(event) => setValue(event.target.value)}
        placeholder="请输入试卷名称"
        showCount
      />
    </Modal>
  )
}
