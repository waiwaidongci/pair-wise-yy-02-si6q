import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  ExecutionPlan,
  NodeKind,
  NodeResult,
  PlanNodeSpec,
  PlanStatus,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import {
  buildPlanSpec,
  reusableResults,
  resultsFromPlans,
} from '../utils/plan'
import {
  autoLayout,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  NODE_DEFINITIONS,
  sampleWorkflow,
} from '../utils/workflow'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface RunOutcome {
  status: 'success' | 'failed' | 'interrupted' | 'duplicate' | 'invalid'
  planId: string | null
  reusedCount: number
  executedCount: number
  totalCount: number
  reason?: string
}

interface RunHandle {
  planId: string
  aborted: boolean
  reason?: string
}

const MAX_ATTEMPTS = 2
const MAX_PLANS = 30
const ABORT_REASON = '执行被中断，尚未开始的节点已取消'

interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  past: Snapshot[]
  future: Snapshot[]
  clipboard: WorkflowNode[]
  notice: string
  running: boolean
  /** 固化下来的执行计划，随流程一起导入导出 */
  executionPlans: ExecutionPlan[]
  activePlanId: string | null
  setName: (name: string) => void
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void
  connect: (connection: Connection) => boolean
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateNode: (id: string, patch: Partial<WorkflowNode['data']>) => void
  updateConfig: (id: string, key: string, value: string | number | boolean) => void
  deleteSelection: () => void
  copySelection: () => void
  pasteSelection: () => void
  layout: () => void
  undo: () => void
  redo: () => void
  clearNotice: () => void
  simulate: () => Promise<RunOutcome>
  interruptRun: () => void
  setActivePlan: (id: string | null) => void
  loadDocument: (document: WorkflowDocument) => void
  reset: () => void
}

const initial = sampleWorkflow()

/** 结果缓存不放进 immer state：它属于运行时数据，不随撤销/重做、节点编辑被快照 */
const resultCache = new Map<string, NodeResult>()
let activeRun: RunHandle | null = null

function snapshot(state: Pick<WorkflowState, 'nodes' | 'edges'>): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  }
}

function pushHistory(state: WorkflowState) {
  state.past.push(snapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

function delay(ms: number, handle?: RunHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      if (handle?.aborted) {
        window.clearInterval(timer)
        reject(new Error(handle.reason ?? ABORT_REASON))
      } else if (Date.now() - started >= ms) {
        window.clearInterval(timer)
        resolve()
      }
    }, 40)
  })
}

/**
 * 依据结果缓存与当前画布重算节点状态：
 * - 结果仍有效（含上游传递有效）→ success，可直接复用；
 * - 结果存在但已失效（配置/连线/上游变更）→ stale；
 * - 无结果的非终态节点回到 idle。
 */
function reconcile(draft: WorkflowState) {
  const valid = reusableResults({ results: resultCache, nodes: draft.nodes, edges: draft.edges })
  for (const node of draft.nodes) {
    const result = resultCache.get(node.id)
    if (result) {
      if (valid.has(node.id)) {
        node.data.status = 'success'
        node.data.duration = result.duration
        node.data.rows = result.rows
      } else if (node.data.status !== 'error' && node.data.status !== 'cancelled'
        && node.data.status !== 'queued' && node.data.status !== 'running') {
        node.data.status = 'stale'
        node.data.duration = result.duration
        node.data.rows = result.rows
      }
    } else if (node.data.status === 'success' || node.data.status === 'stale') {
      node.data.status = 'idle'
      node.data.duration = undefined
      node.data.rows = undefined
    }
  }
  for (const id of [...resultCache.keys()]) {
    if (!draft.nodes.some((node) => node.id === id)) resultCache.delete(id)
  }
}

const NODE_ERRORS: Record<NodeKind, string[]> = {
  source: ['数据源连接超时，未在重试窗口内恢复', '分片读取返回不完整快照'],
  transform: ['表达式执行异常：字段类型不匹配', '派生字段写入触发空值约束'],
  filter: ['过滤表达式编译失败', '采样窗口超出数据集范围'],
  aggregate: ['分组键基数超限', '指标溢出，无法写入 number 端口'],
  join: ['右路数据未在等待窗口内到达', '关联键存在一对多笛卡尔风险'],
  sink: ['目标仓库写入拒绝：分区不存在', '提交事务冲突，回滚失败'],
}

function randomNodeError(spec: PlanNodeSpec): string {
  const pool = NODE_ERRORS[spec.kind] ?? NODE_ERRORS.transform
  return pool[Math.floor(Math.random() * pool.length)]
}

function planId() {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export const useWorkflowStore = create<WorkflowState>()(immer((set, get) => ({
  name: '订单经营分析流程',
  nodes: initial.nodes,
  edges: initial.edges,
  selectedNodeId: null,
  selectedEdgeId: null,
  past: [],
  future: [],
  clipboard: [],
  notice: '端口与类型校验已开启',
  running: false,
  executionPlans: [],
  activePlanId: null,

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
    reconcile(state)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
    reconcile(state)
  }),

  connect: (connection) => {
    const state = get()
    const error = connectionError(connection, state.nodes)
    if (error) {
      set((draft) => { draft.notice = error })
      return false
    }
    if (createsCycle(connection, state.edges)) {
      set((draft) => { draft.notice = '连接被拒绝：检测到环形依赖' })
      return false
    }
    set((draft) => {
      pushHistory(draft)
      const source = draft.nodes.find((node) => node.id === connection.source)
      const sourceHandle = connection.sourceHandle ?? ''
      const type = sourceHandle.startsWith('out-1') ? 'number' : 'dataset'
      draft.edges = addEdge({
        ...connection,
        id: `edge-${Date.now().toString(36)}`,
        type: 'smoothstep',
        animated: true,
        data: { portType: type },
      }, draft.edges) as WorkflowEdge[]
      reconcile(draft)
      draft.notice = '连接成功：受影响节点的历史结果已标记失效'
    })
    return true
  },

  addNode: (kind, position) => set((draft) => {
    pushHistory(draft)
    const node = createWorkflowNode(kind, position ?? { x: 120 + draft.nodes.length * 28, y: 120 + draft.nodes.length * 22 })
    draft.nodes.push(node)
    draft.selectedNodeId = node.id
    draft.selectedEdgeId = null
    draft.notice = `已添加${definitionFor(kind).label}`
  }),

  selectNode: (id) => set((state) => {
    state.selectedNodeId = id
    state.selectedEdgeId = null
  }),

  selectEdge: (id) => set((state) => {
    state.selectedEdgeId = id
    state.selectedNodeId = null
  }),

  updateNode: (id, patch) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (!node) return
    pushHistory(draft)
    const affectsConfig = ('label' in patch && patch.label !== node.data.label)
      || ('description' in patch && patch.description !== node.data.description)
    node.data = { ...node.data, ...patch }
    if (affectsConfig) {
      node.data.configVersion += 1
      resultCache.delete(id)
    }
    reconcile(draft)
  }),

  updateConfig: (id, key, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (!node || node.data.config[key] === value) return
    pushHistory(draft)
    node.data.config[key] = value
    node.data.configVersion += 1
    resultCache.delete(id)
    reconcile(draft)
  }),

  deleteSelection: () => set((draft) => {
    if (!draft.selectedNodeId && !draft.selectedEdgeId) return
    pushHistory(draft)
    if (draft.selectedNodeId) {
      const id = draft.selectedNodeId
      draft.nodes = draft.nodes.filter((node) => node.id !== id)
      draft.edges = draft.edges.filter((edge) => edge.source !== id && edge.target !== id)
      draft.selectedNodeId = null
    }
    if (draft.selectedEdgeId) {
      draft.edges = draft.edges.filter((edge) => edge.id !== draft.selectedEdgeId)
      draft.selectedEdgeId = null
    }
    reconcile(draft)
  }),

  copySelection: () => set((draft) => {
    const selected = draft.nodes.filter((node) => node.id === draft.selectedNodeId)
    draft.clipboard = JSON.parse(JSON.stringify(selected)) as WorkflowNode[]
    if (selected.length) draft.notice = `已复制 ${selected.length} 个节点`
  }),

  pasteSelection: () => set((draft) => {
    if (!draft.clipboard.length) return
    pushHistory(draft)
    const copies = draft.clipboard.map((source) => {
      const copy = JSON.parse(JSON.stringify(source)) as WorkflowNode
      copy.id = `${source.data.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      copy.position = { x: source.position.x + 36, y: source.position.y + 36 }
      copy.selected = false
      copy.data.status = 'idle'
      copy.data.duration = undefined
      copy.data.rows = undefined
      draft.nodes.push(copy)
      return copy
    })
    draft.selectedNodeId = copies[0]?.id ?? null
    draft.notice = `已粘贴 ${copies.length} 个节点`
  }),

  layout: () => set((draft) => {
    pushHistory(draft)
    draft.nodes = autoLayout(draft.nodes, draft.edges)
    draft.notice = '已按依赖层级自动布局'
  }),

  undo: () => set((draft) => {
    const previous = draft.past.pop()
    if (!previous) return
    draft.future.push(snapshot(draft))
    draft.nodes = previous.nodes
    draft.edges = previous.edges
    reconcile(draft)
    draft.notice = '已撤销上一步操作'
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    reconcile(draft)
    draft.notice = '已恢复操作'
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  setActivePlan: (id) => set((draft) => { draft.activePlanId = id }),

  interruptRun: () => {
    if (!activeRun) return
    activeRun.aborted = true
    activeRun.reason = '用户手动中断'
  },

  simulate: async () => {
    const state = get()
    if (activeRun) {
      return {
        status: 'duplicate',
        planId: activeRun.planId,
        reusedCount: 0,
        executedCount: 0,
        totalCount: 0,
        reason: '同一计划正在执行，重复提交已被忽略',
      }
    }
    const spec = buildPlanSpec(state.nodes, state.edges)
    if (!spec) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法生成执行计划' })
      return { status: 'invalid', planId: null, reusedCount: 0, executedCount: 0, totalCount: state.nodes.length }
    }
    if (!spec.nodes.length) {
      set((draft) => { draft.notice = '画布上没有可执行节点' })
      return { status: 'invalid', planId: null, reusedCount: 0, executedCount: 0, totalCount: 0 }
    }

    const reusable = reusableResults({ results: resultCache, nodes: state.nodes, edges: state.edges })

    // 同一签名计划只写入一次；再次提交沿用原计划记录，仅重算失效部分
    const existing = state.executionPlans.find((plan) => plan.signature === spec.signature)
    const id = existing?.id ?? planId()
    const now = new Date().toISOString()

    set((draft) => {
      draft.running = true
      draft.activePlanId = id
      const current = draft.executionPlans.find((item) => item.id === id)
      if (current) {
        current.status = 'running'
        current.startedAt = now
        current.finishedAt = undefined
        current.interruptedReason = undefined
        current.runs = {}
        current.reusedCount = 0
        current.executedCount = 0
      } else {
        const plan: ExecutionPlan = {
          id,
          formatVersion: 1,
          name: `${draft.name} · ${spec.layers.length} 层并发`,
          signature: spec.signature,
          nodes: spec.nodes,
          edges: spec.edges,
          layers: spec.layers,
          status: 'running',
          runs: {},
          createdAt: now,
          startedAt: now,
          reusedCount: 0,
          executedCount: 0,
        }
        draft.executionPlans.unshift(plan)
        if (draft.executionPlans.length > MAX_PLANS) draft.executionPlans.length = MAX_PLANS
      }
      for (const nodeSpec of spec.nodes) {
        const plan = draft.executionPlans.find((item) => item.id === id)!
        const node = draft.nodes.find((item) => item.id === nodeSpec.nodeId)
        const result = resultCache.get(nodeSpec.nodeId)
        if (result && reusable.has(nodeSpec.nodeId)) {
          plan.runs[nodeSpec.nodeId] = {
            nodeId: nodeSpec.nodeId,
            status: 'success',
            attempts: 1,
            cached: true,
            duration: result.duration,
            rows: result.rows,
            finishedAt: result.ranAt,
          }
          if (node) {
            node.data.status = 'success'
            node.data.duration = result.duration
            node.data.rows = result.rows
          }
        } else {
          plan.runs[nodeSpec.nodeId] = { nodeId: nodeSpec.nodeId, status: 'queued', attempts: 0 }
          if (node) {
            node.data.status = 'queued'
            node.data.duration = undefined
            node.data.rows = undefined
          }
        }
      }
    })

    const handle: RunHandle = { planId: id, aborted: false }
    activeRun = handle
    let executedCount = 0
    let terminalStatus: PlanStatus = 'success'
    let terminalReason: string | undefined

    const runNode = async (nodeSpec: PlanNodeSpec): Promise<'success' | 'failed' | 'cancelled'> => {
      executedCount += 1
      const startedAt = new Date().toISOString()
      set((draft) => {
        const plan = draft.executionPlans.find((item) => item.id === id)
        const node = draft.nodes.find((item) => item.id === nodeSpec.nodeId)
        if (plan) plan.runs[nodeSpec.nodeId] = { nodeId: nodeSpec.nodeId, status: 'running', attempts: 0, startedAt }
        if (node) node.data.status = 'running'
      })
      let attempts = 0
      let duration = 0
      try {
        while (attempts < MAX_ATTEMPTS) {
          attempts += 1
          const attemptMs = 220 + Math.round(Math.random() * 480)
          await delay(attemptMs, handle)
          duration += attemptMs
          const failed = Math.random() < (attempts === 1 ? 0.15 : 0.05)
          if (failed) {
            set((draft) => {
              const plan = draft.executionPlans.find((item) => item.id === id)
              if (plan) {
                const run = plan.runs[nodeSpec.nodeId]
                if (run) run.attempts = attempts
              }
            })
            if (attempts < MAX_ATTEMPTS) {
              await delay(280, handle)
              continue
            }
            const error = randomNodeError(nodeSpec)
            const finishedAt = new Date().toISOString()
            set((draft) => {
              const plan = draft.executionPlans.find((item) => item.id === id)
              if (plan) {
                plan.runs[nodeSpec.nodeId] = {
                  nodeId: nodeSpec.nodeId,
                  status: 'error',
                  attempts,
                  duration,
                  error,
                  startedAt,
                  finishedAt,
                }
              }
              const node = draft.nodes.find((item) => item.id === nodeSpec.nodeId)
              if (node) {
                node.data.status = 'error'
                node.data.duration = duration
              }
            })
            return 'failed'
          }
          const rows = 1200 + Math.round(Math.random() * 88000)
          const finishedAt = new Date().toISOString()
          set((draft) => {
            const plan = draft.executionPlans.find((item) => item.id === id)
            if (plan) {
              plan.runs[nodeSpec.nodeId] = {
                nodeId: nodeSpec.nodeId,
                status: 'success',
                attempts,
                duration,
                rows,
                startedAt,
                finishedAt,
              }
            }
            const node = draft.nodes.find((item) => item.id === nodeSpec.nodeId)
            if (node) {
              node.data.status = 'success'
              node.data.duration = duration
              node.data.rows = rows
            }
          })
          resultCache.set(nodeSpec.nodeId, {
            nodeId: nodeSpec.nodeId,
            configVersion: nodeSpec.configVersion,
            inputKeys: nodeSpec.inputKeys,
            duration,
            rows,
            planId: id,
            ranAt: finishedAt,
          })
          return 'success'
        }
        return 'cancelled'
      } catch {
        const finishedAt = new Date().toISOString()
        set((draft) => {
          const plan = draft.executionPlans.find((item) => item.id === id)
          if (plan) {
            plan.runs[nodeSpec.nodeId] = {
              nodeId: nodeSpec.nodeId,
              status: 'cancelled',
              attempts,
              duration,
              error: handle.reason ?? ABORT_REASON,
              startedAt,
              finishedAt,
            }
          }
          const node = draft.nodes.find((item) => item.id === nodeSpec.nodeId)
          if (node) {
            node.data.status = 'cancelled'
            node.data.duration = duration
          }
        })
        return 'cancelled'
      }
    }

    const cancelQueued = (fromLayer: number) => {
      set((draft) => {
        const plan = draft.executionPlans.find((item) => item.id === id)
        if (!plan) return
        for (let layerIndex = fromLayer; layerIndex < spec.layers.length; layerIndex += 1) {
          for (const queuedId of spec.layers[layerIndex]) {
            const run = plan.runs[queuedId]
            if (!run || run.status !== 'queued') continue
            run.status = 'cancelled'
            run.error = terminalReason
            const node = draft.nodes.find((item) => item.id === queuedId)
            if (node) node.data.status = 'cancelled'
          }
        }
      })
    }

    for (let layerIndex = 0; layerIndex < spec.layers.length; layerIndex += 1) {
      const layer = spec.layers[layerIndex].filter((nodeId) => !reusable.has(nodeId))
      if (!layer.length) continue
      const specsById = new Map(spec.nodes.map((item) => [item.nodeId, item]))
      const outcomes = await Promise.all(
        layer.map((nodeId) => runNode(specsById.get(nodeId)!)),
      )
      if (handle.aborted) {
        terminalStatus = 'interrupted'
        terminalReason = handle.reason ?? ABORT_REASON
        cancelQueued(layerIndex + 1)
        break
      }
      const failedIndex = outcomes.findIndex((outcome) => outcome === 'failed')
      if (failedIndex >= 0) {
        const failedId = layer[failedIndex]
        const message = get().executionPlans.find((item) => item.id === id)?.runs[failedId]?.error
          ?? randomNodeError(specsById.get(failedId)!)
        terminalStatus = 'failed'
        terminalReason = `节点「${get().nodes.find((item) => item.id === failedId)?.data.label ?? failedId}」失败：${message}`
        cancelQueued(layerIndex + 1)
        break
      }
    }

    const reusedCount = spec.nodes.length - spec.layers.reduce(
      (sum, layer) => sum + layer.filter((nodeId) => !reusable.has(nodeId)).length,
      0,
    )

    set((draft) => {
      draft.running = false
      const plan = draft.executionPlans.find((item) => item.id === id)
      if (plan) {
        plan.status = terminalStatus
        plan.finishedAt = new Date().toISOString()
        plan.reusedCount = reusedCount
        plan.executedCount = executedCount
        if (terminalReason) plan.interruptedReason = terminalReason
      }
      reconcile(draft)
      if (terminalStatus === 'success') {
        draft.notice = executedCount === 0
          ? `计划 ${id}：${reusedCount} 个节点结果全部可复用，未重新计算`
          : `计划完成：并发 ${spec.layers.length} 层，复用 ${reusedCount} 个结果，新执行 ${executedCount} 个节点`
      } else if (terminalStatus === 'failed') {
        draft.notice = `计划中断于失败节点，已取消后续节点；再次运行将从上一个成功结果恢复`
      } else {
        draft.notice = '执行已中断，尚未开始的节点已取消'
      }
    })
    activeRun = null

    return {
      status: terminalStatus,
      planId: id,
      reusedCount,
      executedCount,
      totalCount: spec.nodes.length,
      reason: terminalReason,
    }
  },

  loadDocument: (document) => set((draft) => {
    resultCache.clear()
    for (const [nodeId, result] of resultsFromPlans(document.executionPlans)) {
      resultCache.set(nodeId, result)
    }
    draft.name = document.name
    draft.nodes = document.nodes
    draft.edges = document.edges
    draft.executionPlans = document.executionPlans
    draft.activePlanId = document.executionPlans[0]?.id ?? null
    draft.past = []
    draft.future = []
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    reconcile(draft)
    draft.notice = '流程 JSON 已导入'
  }),

  reset: () => set((draft) => {
    pushHistory(draft)
    resultCache.clear()
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.executionPlans = []
    draft.activePlanId = null
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.notice = '已恢复示例流程'
  }),
})))

export const nodeDefinitions = NODE_DEFINITIONS

export function statusLabel(status: RunStatus) {
  return {
    idle: '待执行',
    queued: '已排队',
    running: '运行中',
    success: '执行成功',
    error: '执行失败',
    skipped: '已跳过',
    stale: '结果已失效',
    cancelled: '已取消',
  }[status]
}
