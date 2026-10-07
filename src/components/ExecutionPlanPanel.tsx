import { Alert, Badge, Drawer, Empty, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  LoadingOutlined,
  PauseCircleFilled,
  ReloadOutlined,
  ThunderboltFilled,
} from '@ant-design/icons'
import type { ExecutionPlan, PlanStatus, RunStatus, WorkflowNode } from '../types/workflow'
import { definitionFor } from '../utils/workflow'
import { useWorkflowStore } from '../stores/workflow'

const statusTagColor: Record<RunStatus, string> = {
  idle: 'default',
  queued: 'default',
  running: 'processing',
  success: 'success',
  error: 'error',
  skipped: 'warning',
  stale: 'warning',
  cancelled: 'default',
}

const statusText: Record<RunStatus, string> = {
  idle: '待执行',
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  skipped: '跳过',
  stale: '已失效',
  cancelled: '已取消',
}

const planStatusColor: Record<PlanStatus, string> = {
  pending: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
  interrupted: 'warning',
}

const planStatusText: Record<PlanStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '执行成功',
  failed: '节点失败',
  interrupted: '已中断',
}

function statusIcon(status: RunStatus) {
  if (status === 'running') return <LoadingOutlined spin />
  if (status === 'success') return <CheckCircleFilled style={{ color: '#16a34a' }} />
  if (status === 'error') return <CloseCircleFilled style={{ color: '#dc2626' }} />
  if (status === 'cancelled') return <PauseCircleFilled style={{ color: '#94a3b8' }} />
  if (status === 'stale') return <ClockCircleOutlined style={{ color: '#d97706' }} />
  return <ClockCircleOutlined style={{ color: '#94a3b8' }} />
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function ExecutionPlanPanel({ open, onClose }: Props) {
  const plans = useWorkflowStore((state) => state.executionPlans)
  const activePlanId = useWorkflowStore((state) => state.activePlanId)
  const setActivePlan = useWorkflowStore((state) => state.setActivePlan)
  const nodes = useWorkflowStore((state) => state.nodes)
  const selectNode = useWorkflowStore((state) => state.selectNode)

  const active: ExecutionPlan | undefined = plans.find((plan) => plan.id === activePlanId) ?? plans[0]
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  function focusNode(id: string) {
    selectNode(id)
    onClose()
  }

  return (
    <Drawer
      title={
        <div className="plan-drawer-title">
          <ThunderboltFilled style={{ color: '#2563eb' }} />
          <span>执行计划</span>
          <Tag className="plan-version-tag">固化：节点标识 · 配置版本 · 连接关系</Tag>
        </div>
      }
      placement="bottom"
      height="56vh"
      open={open}
      onClose={onClose}
      mask={false}
      className="plan-drawer"
      styles={{ body: { padding: 0 } }}
    >
      <div className="plan-layout">
        <div className="plan-history">
          <div className="plan-history-head">历史计划（{plans.length}）</div>
          {!plans.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无执行计划，点击「提交执行」生成" />}
          {plans.map((plan) => (
            <button
              key={plan.id}
              type="button"
              className={`plan-history-item ${active?.id === plan.id ? 'is-active' : ''}`}
              onClick={() => setActivePlan(plan.id)}
            >
              <Badge status={plan.status === 'failed' ? 'error' : plan.status === 'interrupted' ? 'warning' : plan.status === 'success' ? 'success' : plan.status === 'running' ? 'processing' : 'default'} />
              <span className="plan-history-name" title={plan.name}>{plan.name}</span>
              <span className="plan-history-id">{plan.id.slice(-6)}</span>
              <Tag color={planStatusColor[plan.status]}>{planStatusText[plan.status]}</Tag>
            </button>
          ))}
        </div>
        <div className="plan-detail">
          {!active && <Empty style={{ marginTop: 80 }} description="没有可查看的执行计划" />}
          {active && (
            <>
              <div className="plan-detail-head">
                <div>
                  <Typography.Title level={5} style={{ margin: 0 }}>{active.name}</Typography.Title>
                  <Typography.Text type="secondary" className="plan-meta-line">
                    计划 ID {active.id} · 创建于 {new Date(active.createdAt).toLocaleString('zh-CN')}
                    {active.finishedAt && ` · 结束于 ${new Date(active.finishedAt).toLocaleString('zh-CN')}`}
                  </Typography.Text>
                </div>
                <div className="plan-head-tags">
                  <Tag color={planStatusColor[active.status]}>{planStatusText[active.status]}</Tag>
                  <Tag color="blue">{active.layers.length} 层并发</Tag>
                  <Tag color="green">
                    <CheckCircleFilled /> 复用 {active.reusedCount}
                  </Tag>
                  <Tag color="geekblue">新执行 {active.executedCount}</Tag>
                  <Tag>共 {active.nodes.length} 节点</Tag>
                </div>
              </div>

              {(active.status === 'failed' || active.status === 'interrupted') && active.interruptedReason && (
                <Alert
                  className="plan-alert"
                  type={active.status === 'failed' ? 'error' : 'warning'}
                  showIcon
                  message={active.status === 'failed' ? '中断原因：节点执行失败' : '中断原因'}
                  description={active.interruptedReason}
                />
              )}

              <div className="plan-layers">
                {active.layers.map((layer, layerIndex) => {
                  const runs = layer.map((id) => active.runs[id]).filter(Boolean)
                  const layerDuration = runs.reduce((sum, run) => sum + (run.duration ?? 0), 0)
                  const layerStatus: RunStatus = runs.some((run) => run.status === 'error')
                    ? 'error'
                    : runs.some((run) => run.status === 'running')
                      ? 'running'
                      : runs.every((run) => run.status === 'success')
                        ? 'success'
                        : runs.some((run) => run.status === 'cancelled')
                          ? 'cancelled'
                          : 'queued'
                  return (
                    <div className="plan-layer" key={layerIndex}>
                      <div className="plan-layer-head">
                        <span className="plan-layer-index">第 {layerIndex + 1} 层</span>
                        <Tag>{statusIcon(layerStatus)} {statusText[layerStatus]}</Tag>
                        <Tag color="blue"><ThunderboltFilled /> 并发 {layer.length} 个</Tag>
                        {layerDuration > 0 && <Tag>层耗时 {layerDuration} ms</Tag>}
                      </div>
                      <div className="plan-layer-nodes">
                        {layer.map((nodeId) => {
                          const run = active.runs[nodeId]
                          const node: WorkflowNode | undefined = nodeById.get(nodeId)
                          const definition = node ? definitionFor(node.data.kind) : null
                          const status = run?.status ?? 'idle'
                          return (
                            <Tooltip
                              key={nodeId}
                              title={
                                <div className="plan-chip-tip">
                                  <div>节点：{node?.data.label ?? nodeId}（{nodeId}）</div>
                                  <div>配置版本：v{active.nodes.find((spec) => spec.nodeId === nodeId)?.configVersion ?? '?'}</div>
                                  <div>入边：{active.nodes.find((spec) => spec.nodeId === nodeId)?.inputKeys.length ?? 0} 条</div>
                                  <div>尝试次数：{run?.attempts ?? 0}（最多 2 次，失败自动重试）</div>
                                  {run?.duration !== undefined && <div>耗时：{run.duration} ms</div>}
                                  {run?.rows !== undefined && <div>处理行数：{run.rows.toLocaleString('zh-CN')}</div>}
                                  {run?.error && <div className="plan-chip-error">{run.error}</div>}
                                </div>
                              }
                            >
                              <button
                                type="button"
                                className={`plan-node-chip status-${status}`}
                                style={{ '--node-color': definition?.color ?? '#64748b' } as React.CSSProperties}
                                onClick={() => focusNode(nodeId)}
                              >
                                <span className="plan-node-status">{statusIcon(status)}</span>
                                <span className="plan-node-label">{node?.data.label ?? nodeId}</span>
                                <span className="plan-node-flags">
                                  {run?.cached && <Tag color="green" className="mini-tag">复用</Tag>}
                                  {(run?.attempts ?? 0) > 1 && (
                                    <Tag color="orange" className="mini-tag">
                                      <ReloadOutlined /> 重试 {run.attempts - 1}
                                    </Tag>
                                  )}
                                  {status === 'cancelled' && <Tag className="mini-tag">已取消</Tag>}
                                </span>
                              </button>
                            </Tooltip>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </Drawer>
  )
}
