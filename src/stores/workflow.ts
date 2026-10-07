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
import type { ExecutionPlan, NodeKind, RunStatus, WorkflowDocument, WorkflowEdge, WorkflowNode } from '../types/workflow'
import {
  autoLayout,
  buildExecutionPlan,
  computeFingerprints,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  migrateDocument,
  NODE_DEFINITIONS,
  planFingerprint,
  sampleWorkflow,
  topologicalOrder,
} from '../utils/workflow'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

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
  executionPlan: ExecutionPlan | null
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
  simulate: () => Promise<void>
  loadDocument: (document: WorkflowDocument) => void
  reset: () => void
}

const initial = sampleWorkflow()

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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

type Get = () => WorkflowState
type Set = (fn: (draft: WorkflowState) => void) => void

/** 依据当前画布与已固化计划，标记每个节点的结果是否仍可复用 */
function refreshNodeStatuses(draft: WorkflowState) {
  if (draft.running) return
  const plan = draft.executionPlan
  const fingerprints = computeFingerprints(draft.nodes, draft.edges)
  draft.nodes.forEach((node) => {
    const record = plan?.nodes.find((item) => item.id === node.id)
    const valid = !!plan
      && record?.status === 'success'
      && record.fingerprint === fingerprints[node.id]
    if (valid) {
      node.data.status = 'success'
      node.data.duration = record?.duration
      node.data.rows = record?.rows
    } else {
      node.data.status = 'idle'
      node.data.duration = undefined
      node.data.rows = undefined
    }
  })
}

/** 把计划中各节点的状态同步到画布节点 */
function mirrorPlan(draft: WorkflowState) {
  const plan = draft.executionPlan
  if (!plan) return
  draft.nodes.forEach((node) => {
    const record = plan.nodes.find((item) => item.id === node.id)
    if (!record) {
      node.data.status = 'idle'
      node.data.duration = undefined
      node.data.rows = undefined
      return
    }
    node.data.status = record.status === 'pending' ? 'queued' : record.status
    node.data.duration = record.duration
    node.data.rows = record.rows
  })
}

const MAX_ATTEMPTS = 2

async function runNode(set: Set, get: Get, planId: string, nodeId: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = new Date().toISOString()
    set((draft) => {
      const plan = draft.executionPlan
      if (!plan || plan.id !== planId) return
      const record = plan.nodes.find((item) => item.id === nodeId)
      if (!record || (record.status !== 'queued' && record.status !== 'running')) return
      record.status = 'running'
      record.attempts = attempt
      if (!record.startedAt) record.startedAt = startedAt
      const node = draft.nodes.find((item) => item.id === nodeId)
      if (node) node.data.status = 'running'
    })
    const duration = 240 + Math.round(Math.random() * 620)
    await delay(duration)
    const failed = Math.random() < 0.14
    if (failed && attempt < MAX_ATTEMPTS) {
      set((draft) => {
        const plan = draft.executionPlan
        if (!plan || plan.id !== planId) return
        const record = plan.nodes.find((item) => item.id === nodeId)
        if (record) {
          record.status = 'queued'
          record.retries += 1
        }
        plan.stats.retries += 1
      })
      continue
    }
    set((draft) => {
      const plan = draft.executionPlan
      if (!plan || plan.id !== planId) return
      const record = plan.nodes.find((item) => item.id === nodeId)
      if (!record) return
      const node = draft.nodes.find((item) => item.id === nodeId)
      if (failed) {
        record.status = 'error'
        record.error = '模拟执行失败：数据分片校验未通过'
        record.finishedAt = new Date().toISOString()
        if (node) node.data.status = 'error'
      } else {
        record.status = 'success'
        record.duration = duration
        record.rows = 1200 + Math.round(Math.random() * 88000)
        record.finishedAt = new Date().toISOString()
        if (node) {
          node.data.status = 'success'
          node.data.duration = duration
          node.data.rows = record.rows
        }
      }
    })
    return
  }
}

async function runPlan(set: Set, get: Get, planId: string) {
  for (let layerIndex = 0; ; layerIndex++) {
    const plan = get().executionPlan
    if (!plan || plan.id !== planId || plan.status !== 'running') {
      set((draft) => { draft.running = false })
      return
    }
    const layer = plan.layers[layerIndex]
    if (!layer) break
    const pending = layer.filter((id) => plan.nodes.find((item) => item.id === id)?.status === 'pending')
    if (pending.length) {
      set((draft) => {
        const p = draft.executionPlan
        if (!p || p.id !== planId) return
        pending.forEach((id) => {
          const record = p.nodes.find((item) => item.id === id)
          if (record) record.status = 'queued'
        })
        mirrorPlan(draft)
      })
      // 同层节点并发执行
      await Promise.all(pending.map((id) => runNode(set, get, planId, id)))
    }
    // 并发执行后重新读取最新状态（set 会产生新的状态快照）
    const afterRun = get().executionPlan
    const failedIds = afterRun && afterRun.id === planId
      ? layer.filter((id) => afterRun.nodes.find((item) => item.id === id)?.status === 'error')
      : []
    if (failedIds.length) {
      set((draft) => {
        const p = draft.executionPlan
        if (!p || p.id !== planId) return
        p.status = 'failed'
        p.finishedAt = new Date().toISOString()
        const failedNames = failedIds
          .map((id) => draft.nodes.find((item) => item.id === id)?.data.label ?? id)
          .join('、')
        p.nodes.forEach((record) => {
          if (record.status === 'pending' || record.status === 'queued') record.status = 'skipped'
        })
        p.stats.failed = p.nodes.filter((record) => record.status === 'error').length
        p.stats.skipped = p.nodes.filter((record) => record.status === 'skipped').length
        p.stats.retries = p.nodes.reduce((sum, record) => sum + record.retries, 0)
        const pendingCount = p.stats.skipped
        p.abortReason = `节点「${failedNames}」在第 ${layerIndex + 1} 层执行失败，重试 ${p.stats.retries} 次后仍未成功，${pendingCount} 个未开始节点已取消`
        mirrorPlan(draft)
        draft.running = false
        draft.notice = `执行中断：${failedNames} 失败，已取消未开始节点；再次运行将从上一个成功结果恢复`
      })
      return
    }
  }
  set((draft) => {
    const p = draft.executionPlan
    if (!p || p.id !== planId || p.status !== 'running') {
      draft.running = false
      return
    }
    p.status = 'success'
    p.finishedAt = new Date().toISOString()
    p.stats.executed = p.nodes.filter((record) => record.status === 'success' && !record.cached).length
    p.stats.failed = p.nodes.filter((record) => record.status === 'error').length
    p.stats.skipped = p.nodes.filter((record) => record.status === 'skipped').length
    p.stats.retries = p.nodes.reduce((sum, record) => sum + record.retries, 0)
    mirrorPlan(draft)
    draft.running = false
    draft.notice = `执行计划完成：共 ${p.nodes.length} 个节点，新执行 ${p.stats.executed} 个，复用缓存 ${p.stats.cached} 个，重试 ${p.stats.retries} 次`
  })
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
  executionPlan: null,

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
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
      refreshNodeStatuses(draft)
      draft.notice = '连接成功，端口类型兼容，受影响结果将在下次运行时重算'
    })
    return true
  },

  addNode: (kind, position) => set((draft) => {
    pushHistory(draft)
    const node = createWorkflowNode(kind, position ?? { x: 120 + draft.nodes.length * 28, y: 120 + draft.nodes.length * 22 })
    draft.nodes.push(node)
    draft.selectedNodeId = node.id
    draft.selectedEdgeId = null
    refreshNodeStatuses(draft)
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
    pushHistory(draft)
    const node = draft.nodes.find((item) => item.id === id)
    if (node) {
      node.data = { ...node.data, ...patch }
      refreshNodeStatuses(draft)
    }
  }),

  updateConfig: (id, key, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (!node) return
    pushHistory(draft)
    node.data.config[key] = value
    node.data.configVersion += 1
    refreshNodeStatuses(draft)
    draft.notice = `节点「${node.data.label}」配置已更新，下游结果已失效`
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
    refreshNodeStatuses(draft)
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
      draft.nodes.push(copy)
      return copy
    })
    draft.selectedNodeId = copies[0]?.id ?? null
    refreshNodeStatuses(draft)
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
    refreshNodeStatuses(draft)
    draft.notice = '已撤销上一步操作，结果复用状态已刷新'
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    refreshNodeStatuses(draft)
    draft.notice = '已恢复操作，结果复用状态已刷新'
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  simulate: async () => {
    const state = get()
    if (state.running) return
    if (topologicalOrder(state.nodes, state.edges).length !== state.nodes.length) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法执行' })
      return
    }

    const fingerprint = planFingerprint(state.nodes, state.edges)
    const previous = state.executionPlan

    // 幂等：同一计划（指纹一致）只写入一次，重复提交不产生新计划
    if (previous && previous.fingerprint === fingerprint) {
      if (previous.status === 'success') {
        set((draft) => {
          const plan = draft.executionPlan!
          plan.nodes.forEach((record) => { record.cached = true })
          plan.stats.cached = plan.nodes.length
          plan.stats.executed = 0
          refreshNodeStatuses(draft)
          draft.notice = '执行计划未变更，已有结果全部复用'
        })
        return
      }
      if (previous.status === 'failed') {
        // 从上一个成功结果恢复：复用成功节点，仅重算未完成节点，计划记录保持不变
        set((draft) => {
          draft.running = true
          draft.notice = '正在从上次失败中恢复：复用成功节点，重算未完成节点'
          const plan = draft.executionPlan!
          plan.status = 'running'
          plan.abortReason = undefined
          plan.startedAt = new Date().toISOString()
          plan.finishedAt = undefined
          plan.stats = { total: plan.nodes.length, cached: 0, executed: 0, retries: 0, failed: 0, skipped: 0 }
          plan.nodes.forEach((record) => {
            if (record.status === 'success') {
              record.cached = true
              plan.stats.cached += 1
            } else {
              record.status = 'pending'
              record.cached = false
              record.attempts = 0
              record.retries = 0
              record.duration = undefined
              record.rows = undefined
              record.error = undefined
              record.startedAt = undefined
              record.finishedAt = undefined
            }
          })
          mirrorPlan(draft)
        })
        await runPlan(set, get, previous.id)
        return
      }
    }

    const plan = buildExecutionPlan(state.nodes, state.edges, previous)
    set((draft) => {
      draft.running = true
      draft.executionPlan = plan
      draft.notice = '执行计划已生成，按依赖层级并发执行'
      mirrorPlan(draft)
    })
    await runPlan(set, get, plan.id)
  },

  loadDocument: (document) => set((draft) => {
    const migrated = migrateDocument(document)
    draft.name = document.name
    draft.nodes = migrated.nodes
    draft.edges = migrated.edges
    draft.executionPlan = migrated.executionPlan
    draft.past = []
    draft.future = []
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    if (migrated.executionPlan) {
      mirrorPlan(draft)
      draft.notice = '流程 JSON 已导入，执行计划已随流程恢复'
    } else {
      draft.notice = '流程 JSON 已导入（旧版流程已升级：首次运行将生成执行计划）'
    }
  }),

  reset: () => set((draft) => {
    pushHistory(draft)
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.executionPlan = null
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
  }[status]
}
