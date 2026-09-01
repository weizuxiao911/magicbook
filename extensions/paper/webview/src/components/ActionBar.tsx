import { Button, Checkbox } from 'antd'

interface Props {
  hasSelection: boolean
  allSelected: boolean
  disabled?: boolean
  operationDisabled?: boolean
  onJoinAll: () => void
  onJoinSelected: () => void
  onSavePaper: () => void
  onToggleAll: (checked: boolean) => void
  showClose?: boolean
  onClose?: () => void
}

export function ActionBar({
  hasSelection,
  allSelected,
  disabled = false,
  operationDisabled = false,
  onJoinAll,
  onJoinSelected,
  onSavePaper,
  onToggleAll,
  showClose = false,
  onClose
}: Props) {
  const actionDisabled = disabled || operationDisabled

  return (
    <div className="paper-actions">
      {hasSelection && !operationDisabled ? (
        <Checkbox checked={allSelected} onChange={(event) => onToggleAll(event.target.checked)} disabled={disabled}>
          <span className="paperui-primary-text">全选</span>
        </Checkbox>
      ) : null}
      <Button onClick={hasSelection ? onJoinSelected : onJoinAll} disabled={actionDisabled}>
        {hasSelection ? '将选中题目加入题库' : '全部加入题库'}
      </Button>
      <Button type="primary" onClick={onSavePaper} disabled={actionDisabled}>
        存入试卷库
      </Button>
      {showClose && onClose ? (
        <Button onClick={onClose} disabled={disabled}>
          关闭
        </Button>
      ) : null}
    </div>
  )
}
