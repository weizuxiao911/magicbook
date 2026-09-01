import { Typography, Tooltip } from 'antd'
import type { ReactNode } from 'react'

interface Props {
  tip: ReactNode
  icon: ReactNode
  onClick?: () => void
  disabled?: boolean
}

export function IconLay({ tip, icon, onClick, disabled = false }: Props) {
  return (
    <Tooltip title={tip} placement="top" color="white" arrow={false} overlayClassName="tooltip-white">
      <Typography.Link
        className={disabled ? 'paperui-blue-btn paperui-blue-btn-disabled' : 'paperui-blue-btn'}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            onClick?.()
          }
        }}
      >
        {icon}
      </Typography.Link>
    </Tooltip>
  )
}
