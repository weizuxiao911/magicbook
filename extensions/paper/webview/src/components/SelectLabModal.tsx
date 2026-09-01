import { Button, Flex, Form, Modal, Select } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { requestHost } from '../api/client'
import type { LabItem } from '../types'

interface Props {
  open: boolean
  onCancel: () => void
  onOk: (labCode: string) => void
}

export function SelectLabModal({ open, onCancel, onOk }: Props) {
  const [form] = Form.useForm<{ code?: string }>()
  const [options, setOptions] = useState<{ label: string; value: string }[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const fetchLabs = useCallback(async (keywords: string) => {
    setSearching(true)
    try {
      const res = await requestHost<{ rows: LabItem[]; hasNext: boolean }>('search-labs', { keywords: keywords || undefined })
      setOptions((res?.rows ?? []).map((it) => ({ label: it.name, value: it.code })))
    } catch {
      setOptions([])
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchLabs('')
    }
  }, [open, fetchLabs])

  const handleSearch = useCallback((value: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      fetchLabs(value)
    }, 500)
  }, [fetchLabs])

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      footer={
        <Flex align="center" justify="center" gap={20} style={{ marginTop: 40 }}>
          <Button type="default" onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            onClick={async () => {
              const values = await form.validateFields().catch(() => undefined)
              if (!values?.code) return
              onOk(values.code)
            }}
          >
            保存
          </Button>
        </Flex>
      }
      closable={false}
      centered
      width={500}
      maskClosable={false}
      destroyOnClose
      afterClose={() => {
        form.resetFields()
        setOptions([])
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 600, textAlign: 'center', margin: '6px 0 28px' }}>
        选择教培实验室
      </div>
      <Form
        form={form}
        autoComplete="off"
        layout="horizontal"
        labelCol={{ flex: '0 0 80px' }}
        wrapperCol={{ flex: 1 }}
        preserve={false}
      >
        <Form.Item
          label="实验室"
          name="code"
          rules={[{ required: true, message: '请选择实验室' }]}
          extra={null}
        >
          <Select
            showSearch
            placeholder="请选择实验室"
            loading={searching}
            style={{ width: '100%' }}
            filterOption={false}
            onSearch={handleSearch}
            onChange={(value) => {
              form.setFieldValue('code', value)
            }}
            options={options}
            notFoundContent={searching ? '搜索中…' : '暂无数据'}
            defaultActiveFirstOption={false}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
