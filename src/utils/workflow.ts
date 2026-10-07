import type { Connection } from '@xyflow/react'
import type {
  ExecutionPlan,
  NodeConfig,
  NodeDefinition,
  PlanEdgeRecord,
  PlanNodeRecord,
  PortType,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'

export const NODE_DEFINITIONS: NodeDefinition[] = [
  {
    kind: 'source',
    label: '数据源',
    description: '读取订单、用户或日志数据集',
    color: '#2563eb',
    inputs: [],
    outputs: ['dataset'],
  },
  {
    kind: 'transform',
    label: '字段变换',
    description: '清洗、映射与派生字段',
    color: '#0891b2',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'filter',
    label: '条件过滤',
    description: '按表达式筛选数据行',
    color: '#7c3aed',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'aggregate',
    label: '聚合计算',
    description: '分组汇总并输出指标',
    color: '#ca8a04',
    inputs: ['dataset'],
    outputs: ['number'],
  },
  {
    kind: 'join',
    label: '双流关联',
    description: '按关联键合并两路数据',
    color: '#db2777',
    inputs: ['dataset', 'dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'sink',
    label: '结果输出',
    description: '写入数据仓库或消息队列',
    color: '#16a34a',
    inputs: ['dataset', 'number'],
    outputs: [],
  },
]

export function definitionFor(kind: WorkflowNode['data']['kind']) {
  return NODE_DEFINITIONS.find((item) => item.kind === kind) ?? NODE_DEFINITIONS[0]
}

export function defaultConfig(kind: WorkflowNode['data']['kind']) {
  const configs: Record<WorkflowNode['data']['kind'], Record<string, string | number | boolean>> = {
    source: { source: '订单主表', refresh: '实时', sampleRows: 125000 },
    transform: { expression: 'amount * 1.06', outputField: 'amount_with_tax', keepOriginal: true },
    filter: { expression: 'status == "已支付"', limit: 50000 },
    aggregate: { groupBy: 'region', metric: 'sum(amount)', outputField: 'region_total' },
    join: { joinType: 'left', leftKey: 'customer_id', rightKey: 'id' },
    sink: { target: '分析数据集市', mode: 'upsert', partition: 'dt' },
  }
  return configs[kind]
}

export function createWorkflowNode(
  kind: WorkflowNode['data']['kind'],
  position: { x: number; y: number },
  id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
): WorkflowNode {
  const definition = definitionFor(kind)
  return {
    id,
    type: 'workflow',
    position,
    data: {
      label: definition.label,
      kind,
      description: definition.description,
      config: defaultConfig(kind),
      configVersion: 1,
      status: 'idle',
    },
  }
}

export function portAt(node: WorkflowNode, handle: string | null | undefined): { direction: 'input' | 'output'; type: PortType; index: number } | null {
  if (!handle) return null
  const match = /^(in|out)-(\d+)$/.exec(handle)
  if (!match) return null
  const definition = definitionFor(node.data.kind)
  const index = Number(match[2])
  const direction = match[1] === 'in' ? 'input' : 'output'
  const type = direction === 'input' ? definition.inputs[index] : definition.outputs[index]
  return type ? { direction, type, index } : null
}

export function connectionError(connection: Connection, nodes: WorkflowNode[]): string | null {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
    return '连接缺少有效的源端口或目标端口'
  }
  if (connection.source === connection.target) return '节点不能连接到自身'

  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return '连接节点不存在'

  const sourcePort = portAt(source, connection.sourceHandle)
  const targetPort = portAt(target, connection.targetHandle)
  if (!sourcePort || sourcePort.direction !== 'output') return '源端口类型无效'
  if (!targetPort || targetPort.direction !== 'input') return '目标端口类型无效'

  const compatible = sourcePort.type === 'any'
    || targetPort.type === 'any'
    || sourcePort.type === targetPort.type
  if (!compatible) return `端口类型不兼容：${sourcePort.type} → ${targetPort.type}`

  return null
}

export function createsCycle(connection: Connection, edges: WorkflowEdge[]): boolean {
  if (!connection.source || !connection.target) return false
  const adjacency = new Map<string, string[]>()
  edges.forEach((edge) => {
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  })
  const sourceList = adjacency.get(connection.source) ?? []
  sourceList.push(connection.target)
  adjacency.set(connection.source, sourceList)

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (hasCycle(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return [...adjacency.keys()].some(hasCycle)
}

export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  edges.forEach((edge) => {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const result: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return result
}

export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const order = topologicalOrder(nodes, edges)
  const depth = new Map<string, number>()
  order.forEach((id) => {
    const parents = edges.filter((edge) => edge.target === id)
    depth.set(id, parents.length ? Math.max(...parents.map((edge) => (depth.get(edge.source) ?? 0) + 1)) : 0)
  })
  const columns = new Map<number, WorkflowNode[]>()
  nodes.forEach((node) => {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  })
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 0
    const index = (columns.get(column) ?? []).findIndex((item) => item.id === node.id)
    return { ...node, position: { x: 90 + column * 260, y: 90 + index * 150 } }
  })
}

/** FNV-1a 32 位哈希，用于生成稳定的指纹 */
export function hashString(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function stableConfig(config: NodeConfig): string {
  const sorted = Object.keys(config)
    .sort()
    .reduce<NodeConfig>((acc, key) => {
      acc[key] = config[key]
      return acc
    }, {})
  return JSON.stringify(sorted)
}

/** 按依赖深度分层：同层节点互不依赖，可并发执行 */
export function computeLayers(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  nodes.forEach((node) => {
    indegree.set(node.id, 0)
    outgoing.set(node.id, [])
  })
  edges.forEach((edge) => {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) return
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })

  const depth = new Map<string, number>()
  const queue: string[] = []
  nodes.forEach((node) => {
    if (indegree.get(node.id) === 0) {
      depth.set(node.id, 0)
      queue.push(node.id)
    }
  })

  const layers: string[][] = []
  while (queue.length) {
    const id = queue.shift()!
    const layer = depth.get(id) ?? 0
    if (!layers[layer]) layers[layer] = []
    layers[layer].push(id)
    for (const next of outgoing.get(id) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, layer + 1)
      depth.set(next, nextDepth)
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }

  // 环中的节点（正常会被前置校验拦截）兜底放入首层
  nodes.forEach((node) => {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0)
      if (!layers[0]) layers[0] = []
      layers[0].push(node.id)
    }
  })
  return layers.filter((layer) => layer.length > 0)
}

export function edgeRecordOf(edge: WorkflowEdge): PlanEdgeRecord {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? '',
    targetHandle: edge.targetHandle ?? '',
    portType: edge.data?.portType ?? 'dataset',
  }
}

/**
 * 计算每个节点的结果指纹：
 * 节点类型 + 配置版本 + 配置内容 + 入边集合 + 上游指纹，
 * 任一上游或连线变化都会沿依赖链向下传导。
 */
export function computeFingerprints(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, string> {
  const edgeRecords = edges.map(edgeRecordOf)
  const fingerprints: Record<string, string> = {}
  for (const layer of computeLayers(nodes, edges)) {
    for (const id of layer) {
      const node = nodes.find((item) => item.id === id)
      if (!node) continue
      const incoming = edgeRecords.filter((edge) => edge.target === id)
      const edgeSig = incoming
        .map((edge) => `${edge.source}>${edge.sourceHandle}>${edge.targetHandle}>${edge.portType}`)
        .sort()
        .join('|')
      const upstreamSig = incoming
        .map((edge) => fingerprints[edge.source] ?? '')
        .sort()
        .join('|')
      fingerprints[id] = hashString(
        `${node.data.kind}#${node.data.configVersion}#${stableConfig(node.data.config)}|${edgeSig}|${upstreamSig}`,
      )
    }
  }
  return fingerprints
}

/** 计划指纹：节点标识+配置版本 与 连接关系 的整体摘要，作为幂等提交的依据 */
export function planFingerprint(nodes: WorkflowNode[], edges: WorkflowEdge[]): string {
  const nodeSig = nodes
    .map((node) => `${node.id}@${node.data.configVersion}`)
    .sort()
    .join(',')
  const edgeSig = edges
    .map((edge) => `${edge.source}${edge.sourceHandle ?? ''}-${edge.target}${edge.targetHandle ?? ''}:${edge.data?.portType ?? 'dataset'}`)
    .sort()
    .join(',')
  return hashString(`N:${nodeSig}|E:${edgeSig}`)
}

/** 依据当前画布生成执行计划，并标记可复用的历史成功结果 */
export function buildExecutionPlan(nodes: WorkflowNode[], edges: WorkflowEdge[], previous: ExecutionPlan | null): ExecutionPlan {
  const layers = computeLayers(nodes, edges)
  const edgeRecords = edges.map(edgeRecordOf)
  const fingerprints = computeFingerprints(nodes, edges)
  const previousRecords = new Map(previous?.nodes.map((record) => [record.id, record]) ?? [])

  const records: PlanNodeRecord[] = nodes.map((node) => {
    const fingerprint = fingerprints[node.id]
    const before = previousRecords.get(node.id)
    const cached = !!before && before.status === 'success' && before.fingerprint === fingerprint
    return {
      id: node.id,
      kind: node.data.kind,
      configVersion: node.data.configVersion,
      fingerprint,
      status: cached ? 'success' : 'pending',
      cached,
      attempts: 0,
      retries: 0,
      duration: cached ? before?.duration : undefined,
      rows: cached ? before?.rows : undefined,
    }
  })

  const cachedCount = records.filter((record) => record.cached).length
  return {
    id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    version: 1,
    fingerprint: planFingerprint(nodes, edges),
    createdAt: new Date().toISOString(),
    status: 'running',
    layers,
    nodes: records,
    edges: edgeRecords,
    stats: { total: records.length, cached: cachedCount, executed: 0, retries: 0, failed: 0, skipped: 0 },
  }
}

/** 打开旧版流程时升级：补齐缺失的配置版本与计划字段，剔除失效引用 */
export function migrateDocument(document: WorkflowDocument): {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  executionPlan: ExecutionPlan | null
} {
  const nodes = (document.nodes ?? []).map((node) => ({
    ...node,
    data: {
      ...node.data,
      config: (node.data.config ?? {}) as NodeConfig,
      configVersion: typeof node.data.configVersion === 'number' ? node.data.configVersion : 1,
      status: 'idle' as RunStatus,
      duration: undefined,
      rows: undefined,
    },
  })) as WorkflowNode[]

  const edges = (document.edges ?? []).map((edge) => ({
    ...edge,
    data: { portType: edge.data?.portType ?? 'dataset' as PortType },
  })) as WorkflowEdge[]

  const knownIds = new Set(nodes.map((node) => node.id))
  let executionPlan: ExecutionPlan | null = null
  if (document.executionPlan && document.executionPlan.version === 1) {
    const plan = document.executionPlan
    executionPlan = {
      ...plan,
      // 导出时若仍在执行，视为中断，避免导入一个“运行中”的计划
      status: plan.status === 'running' ? 'failed' : plan.status,
      abortReason: plan.status === 'running' ? '导入的计划在导出时尚未结束' : plan.abortReason,
      nodes: plan.nodes
        .filter((record) => knownIds.has(record.id))
        .map((record) => ({ ...record, cached: false })),
      edges: plan.edges.filter((edge) => knownIds.has(edge.source) && knownIds.has(edge.target)),
      layers: plan.layers
        .map((layer) => layer.filter((id) => knownIds.has(id)))
        .filter((layer) => layer.length > 0),
    }
  }

  return { nodes, edges, executionPlan }
}

export function sampleWorkflow(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const source = createWorkflowNode('source', { x: 60, y: 150 }, 'source-orders')
  source.data.label = '订单实时流'
  const filter = createWorkflowNode('filter', { x: 330, y: 70 }, 'filter-paid')
  filter.data.label = '筛选已支付订单'
  const transform = createWorkflowNode('transform', { x: 330, y: 250 }, 'transform-clean')
  transform.data.label = '清洗收货信息'
  const join = createWorkflowNode('join', { x: 610, y: 160 }, 'join-customer')
  join.data.label = '关联客户画像'
  const aggregate = createWorkflowNode('aggregate', { x: 880, y: 160 }, 'aggregate-region')
  aggregate.data.label = '区域销售聚合'
  const sink = createWorkflowNode('sink', { x: 1150, y: 160 }, 'sink-warehouse')
  sink.data.label = '写入经营看板'
  return {
    nodes: [source, filter, transform, join, aggregate, sink],
    edges: [
      { id: 'e1', source: source.id, sourceHandle: 'out-0', target: filter.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' }, animated: true },
      { id: 'e2', source: source.id, sourceHandle: 'out-0', target: transform.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e3', source: filter.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e4', source: transform.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e5', source: join.id, sourceHandle: 'out-0', target: aggregate.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e6', source: aggregate.id, sourceHandle: 'out-0', target: sink.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'number' } },
    ],
  }
}
