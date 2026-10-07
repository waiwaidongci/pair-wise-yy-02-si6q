import { Alert, Empty, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloudDownloadOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { Panel } from '@xyflow/react'
import { useWorkflowStore } from '../stores/workflow'
import type { PlanNodeRecord, PlanNodeRunStatus } from '../types/workflow'

const statusMeta: Record<PlanNodeRunStatus, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: '待执行', color: 'default', icon: <MinusCircleOutlined /> },
  queued: { label: '已排队', color: 'default', icon: <MinusCircleOutlined /> },
  running: { label: '运行中', color: 'blue', icon: <LoadingOutlined spin /> },
  success: { label: '成功', color: 'green', icon: <CheckCircleFilled /> },
  error: { label: '失败', color: 'red', icon: <CloseCircleFilled /> },
  skipped: { label: '已取消', color: 'default', icon: <MinusCircleOutlined /> },
}

function NodeChip({ record, label }: { record: PlanNodeRecord; label: string }) {
  const meta = statusMeta[record.status]
  return (
    <Tooltip
      title={
        <div className="plan-chip-tooltip">
          <div>{label}</div>
          <div>状态：{meta.label}</div>
          <div>配置版本：v{record.configVersion}</div>
          <div>尝试 / 重试：{record.attempts} / {record.retries}</div>
          {record.duration !== undefined && <div>耗时：{record.duration} ms</div>}
          {record.rows !== undefined && <div>行数：{record.rows.toLocaleString('zh-CN')}</div>}
          {record.error && <div>原因：{record.error}</div>}
          <div>指纹：{record.fingerprint}</div>
        </div>
      }
    >
      <span className={`plan-chip plan-chip-${record.status}`}>
        <span className="plan-chip-icon">{meta.icon}</span>
        <span className="plan-chip-label">{label}</span>
        {record.cached && <Tag className="plan-chip-tag" color="cyan">复用</Tag>}
        {record.retries > 0 && <Tag className="plan-chip-tag" color="orange">重试 ×{record.retries}</Tag>}
      </span>
    </Tooltip>
  )
}

export default function ExecutionPlanPanel() {
  const plan = useWorkflowStore((state) => state.executionPlan)
  const nodes = useWorkflowStore((state) => state.nodes)
  const running = useWorkflowStore((state) => state.running)

  if (!plan) {
    return (
      <Panel position="bottom-center">
        <div className="plan-panel plan-panel-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>尚未生成执行计划<br />点击「模拟执行」将按当前画布固化计划</span>
            }
          />
        </div>
      </Panel>
    )
  }

  const labelOf = (id: string) => nodes.find((node) => node.id === id)?.data.label ?? id
  const statusColor = plan.status === 'success' ? 'green' : plan.status === 'failed' ? 'red' : 'blue'
  const statusText = plan.status === 'success' ? '全部成功' : plan.status === 'failed' ? '中断' : '执行中'

  return (
    <Panel position="bottom-center">
      <div className="plan-panel">
        <div className="plan-panel-header">
          <div className="plan-panel-title">
            <ThunderboltOutlined />
            <strong>执行计划</strong>
            <Tag color={statusColor}>{statusText}</Tag>
            {running && <LoadingOutlined spin className="plan-panel-running" />}
          </div>
          <div className="plan-panel-meta">
            <Tooltip title="计划指纹（幂等校验依据）">
              <span>#{plan.fingerprint}</span>
            </Tooltip>
            <span>{new Date(plan.createdAt).toLocaleTimeString('zh-CN')}</span>
            {plan.stats.cached > 0 && (
              <Tooltip title="结果复用上一轮计划，未重新执行">
                <span><CloudDownloadOutlined /> 复用 {plan.stats.cached}</span>
              </Tooltip>
            )}
          </div>
        </div>

        {plan.abortReason && (
          <Alert className="plan-abort" type="error" showIcon message="执行中断" description={plan.abortReason} />
        )}

        <div className="plan-layers">
          {plan.layers.map((layer, index) => (
            <div key={index} className="plan-layer">
              <div className="plan-layer-head">
                <span className="plan-layer-name">L{index + 1}</span>
                <Typography.Text type="secondary" className="plan-layer-concurrency">
                  并发 {layer.length}
                </Typography.Text>
              </div>
              <div className="plan-layer-chips">
                {layer.map((id) => {
                  const record = plan.nodes.find((item) => item.id === id)
                  if (!record) return null
                  return <NodeChip key={id} record={record} label={labelOf(id)} />
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="plan-stats">
          <span>节点 {plan.stats.total}</span>
          <span className="plan-stat-cached">复用 {plan.stats.cached}</span>
          <span>新执行 {plan.stats.executed}</span>
          <span className="plan-stat-retries">重试 {plan.stats.retries}</span>
          <span className="plan-stat-failed">失败 {plan.stats.failed}</span>
          <span className="plan-stat-skipped">跳过 {plan.stats.skipped}</span>
        </div>
      </div>
    </Panel>
  )
}
