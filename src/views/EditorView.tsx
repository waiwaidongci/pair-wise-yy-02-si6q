import { App as AntApp, Badge, Button, Input, Space, Tooltip, Upload } from 'antd'
import {
  ApartmentOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  SnippetsOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useRef, useState } from 'react'
import type { UploadProps } from 'antd'
import NodePalette from '../components/NodePalette'
import Inspector from '../components/Inspector'
import WorkflowCanvas from '../components/WorkflowCanvas'
import ExecutionPlanPanel from '../components/ExecutionPlanPanel'
import { useWorkflowStore } from '../stores/workflow'
import { migrateDocument } from '../utils/plan'
import type { WorkflowDocument } from '../types/workflow'

export default function EditorView() {
  const { message } = AntApp.useApp()
  const uploadRef = useRef<HTMLInputElement>(null)
  const store = useWorkflowStore()
  const [planPanelOpen, setPlanPanelOpen] = useState(false)

  function exportJson() {
    const document: WorkflowDocument = {
      version: 2,
      name: store.name,
      nodes: store.nodes,
      edges: store.edges,
      executionPlans: store.executionPlans,
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${store.name.replace(/\s+/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    message.success('流程 JSON 已导出（含执行计划）')
  }

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: async (file) => {
      try {
        const { document, upgraded, warnings } = migrateDocument(JSON.parse(await file.text()))
        store.loadDocument(document)
        if (upgraded) {
          message.success('旧版流程已升级到 v2，可正常编辑与复用')
        } else {
          message.success('流程导入成功')
        }
        warnings.forEach((warning) => message.info(warning))
      } catch (error) {
        message.error(error instanceof Error ? error.message : '流程 JSON 无效')
      }
      return false
    },
  }

  async function run() {
    const outcome = await store.simulate()
    if (outcome.status === 'invalid') {
      message.error(outcome.reason ?? '当前画布无法生成执行计划')
      return
    }
    if (outcome.status === 'duplicate') {
      message.warning(outcome.reason ?? '同一计划重复提交已被忽略')
      return
    }
    const summary = `共 ${outcome.totalCount} 节点，复用 ${outcome.reusedCount}，新执行 ${outcome.executedCount}`
    if (outcome.status === 'success') {
      message.success({ content: `计划执行完成：${summary}`, key: 'run', duration: 4 })
    } else if (outcome.status === 'failed') {
      message.error({
        content: `计划在失败节点处中断，后续节点已取消；再点执行将从成功结果恢复。${outcome.reason ?? ''}`,
        key: 'run',
        duration: 6,
      })
    } else {
      message.warning({ content: `执行已中断：${outcome.reason ?? '尚未开始的节点已取消'}`, key: 'run', duration: 5 })
    }
    setPlanPanelOpen(true)
  }

  function interrupt() {
    store.interruptRun()
    message.loading({ content: '正在中断：取消尚未开始的节点…', key: 'run' })
  }

  return (
    <div className="editor-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">FP</div>
          <div><strong>FlowPilot</strong><span>数据工作流编排平台</span></div>
        </div>
        <Input
          className="flow-name"
          value={store.name}
          onChange={(event) => store.setName(event.target.value)}
          prefix={<SnippetsOutlined />}
        />
        <Space wrap>
          <Tooltip title="撤销"><Button icon={<UndoOutlined />} disabled={!store.past.length} onClick={store.undo} /></Tooltip>
          <Tooltip title="重做"><Button icon={<RedoOutlined />} disabled={!store.future.length} onClick={store.redo} /></Tooltip>
          <Tooltip title="复制"><Button icon={<CopyOutlined />} onClick={store.copySelection} /></Tooltip>
          <Tooltip title="粘贴"><Button icon={<SnippetsOutlined />} onClick={store.pasteSelection} /></Tooltip>
          <Tooltip title="删除"><Button danger icon={<DeleteOutlined />} onClick={store.deleteSelection} /></Tooltip>
          <Button icon={<ApartmentOutlined />} onClick={store.layout}>自动布局</Button>
          <Upload {...uploadProps}><Button icon={<CloudUploadOutlined />}>导入</Button></Upload>
          <Button icon={<CloudDownloadOutlined />} onClick={exportJson}>导出</Button>
          <Button icon={<ReloadOutlined />} onClick={store.reset}>重置</Button>
          <Tooltip title="同一计划重复提交只写入一次；失败后再点将从上一个成功结果恢复">
            <Badge count={store.executionPlans.length} size="small" offset={[-6, 4]} color="#94a3b8">
              <Button icon={<ThunderboltOutlined />} onClick={() => setPlanPanelOpen(true)}>执行计划</Button>
            </Badge>
          </Tooltip>
          {store.running
            ? <Button danger icon={<PauseCircleOutlined />} onClick={interrupt}>中断</Button>
            : (
              <Tooltip title="固化执行计划：节点标识、配置版本、连接关系；同层并发，可复用成功结果">
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={run}>提交执行</Button>
              </Tooltip>
            )}
        </Space>
      </header>
      <main className="editor-grid">
        <NodePalette />
        <WorkflowCanvas />
        <Inspector />
      </main>
      <ExecutionPlanPanel open={planPanelOpen} onClose={() => setPlanPanelOpen(false)} />
    </div>
  )
}
