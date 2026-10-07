import type {
  ExecutionPlan,
  NodeResult,
  PlanEdgeSpec,
  PlanNodeSpec,
  PortType,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'

/**
 * 拓扑分层：每个节点一层，层内节点互不依赖，可并发执行。
 * 若存在环，返回 null。
 */
export function topologicalLayers(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] | null {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  edges.forEach((edge) => {
    if (!indegree.has(edge.target) || !indegree.has(edge.source)) return
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  let frontier = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const layers: string[][] = []
  const seen = new Set<string>()
  while (frontier.length) {
    const layer = [...frontier].sort()
    layers.push(layer)
    const next: string[] = []
    for (const id of layer) {
      seen.add(id)
      for (const target of outgoing.get(id) ?? []) {
        indegree.set(target, (indegree.get(target) ?? 0) - 1)
        if (indegree.get(target) === 0) next.push(target)
      }
    }
    frontier = next
  }
  return seen.size === nodes.length ? layers : null
}

/** 连接关系键：不依赖 edge.id，仅描述「谁从哪个端口连到谁」，edge.id 变化不算关系变更 */
export function edgeKey(edge: Pick<WorkflowEdge, 'source' | 'sourceHandle' | 'target' | 'targetHandle'>): string {
  return `${edge.source}#${edge.sourceHandle ?? ''}->${edge.target}#${edge.targetHandle ?? ''}`
}

export function portTypeOf(edge: WorkflowEdge): PortType {
  return edge.data?.portType ?? 'dataset'
}

function djb2(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/** 由节点标识、配置版本与连接关系计算计划签名 */
export function planSignature(specs: PlanNodeSpec[], edges: PlanEdgeSpec[]): string {
  const nodePart = specs
    .map((spec) => `${spec.nodeId}@v${spec.configVersion}`)
    .sort()
    .join('|')
  const edgePart = edges.map((edge) => edge.key).sort().join('|')
  return djb2(`${nodePart}::${edgePart}`)
}

export interface PlanSpec {
  nodes: PlanNodeSpec[]
  edges: PlanEdgeSpec[]
  layers: string[][]
  signature: string
}

/** 把当前画布固化成一份执行计划规格 */
export function buildPlanSpec(nodes: WorkflowNode[], edges: WorkflowEdge[]): PlanSpec | null {
  const layers = topologicalLayers(nodes, edges)
  if (!layers) return null
  const edgeSpecs: PlanEdgeSpec[] = edges.map((edge) => ({
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? null,
    target: edge.target,
    targetHandle: edge.targetHandle ?? null,
    portType: portTypeOf(edge),
    key: edgeKey(edge),
  }))
  const nodeSpecs: PlanNodeSpec[] = nodes.map((node) => ({
    nodeId: node.id,
    kind: node.data.kind,
    configVersion: node.data.configVersion,
    inputKeys: edgeSpecs.filter((edge) => edge.target === node.id).map((edge) => edge.key).sort(),
  }))
  return {
    nodes: nodeSpecs,
    edges: edgeSpecs,
    layers,
    signature: planSignature(nodeSpecs, edgeSpecs),
  }
}

export interface ResultContext {
  results: Map<string, NodeResult>
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/**
 * 判定某节点的上一次成功结果当前是否仍可复用：
 * 1. 节点自身配置版本未变；2. 入边关系未变；3. 所有上游结果仍然有效（传递失效）。
 */
export function isResultValid(
  nodeId: string,
  context: ResultContext,
  cache: Set<string> = new Set(),
): boolean {
  if (cache.has(nodeId)) return true
  const result = context.results.get(nodeId)
  if (!result) return false
  const node = context.nodes.find((item) => item.id === nodeId)
  if (!node) return false
  if (node.data.configVersion !== result.configVersion) return false
  const incoming = context.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edgeKey(edge))
    .sort()
  if (incoming.join('|') !== result.inputKeys.join('|')) return false
  cache.add(nodeId)
  const upstreams = [...new Set(context.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source))]
  const upstreamsValid = upstreams.every((upstreamId) => isResultValid(upstreamId, context, cache))
  if (!upstreamsValid) {
    cache.delete(nodeId)
    return false
  }
  return true
}

/** 当前画布上仍可复用的成功结果节点集合 */
export function reusableResults(context: ResultContext): Set<string> {
  const valid = new Set<string>()
  context.results.forEach((_result, nodeId) => {
    if (isResultValid(nodeId, context, valid)) valid.add(nodeId)
  })
  return valid
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asPlan(value: unknown, index: number): ExecutionPlan | null {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || !Array.isArray(record.nodes) || !Array.isArray(record.layers)) {
    return null
  }
  return {
    formatVersion: 1,
    id: record.id,
    name: typeof record.name === 'string' ? record.name : `执行计划 ${index + 1}`,
    signature: typeof record.signature === 'string' ? record.signature : '',
    nodes: record.nodes as ExecutionPlan['nodes'],
    edges: Array.isArray(record.edges) ? (record.edges as ExecutionPlan['edges']) : [],
    layers: record.layers as ExecutionPlan['layers'],
    status: typeof record.status === 'string' ? (record.status as ExecutionPlan['status']) : 'pending',
    runs: asRecord(record.runs) ? (record.runs as ExecutionPlan['runs']) : {},
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : undefined,
    interruptedReason: typeof record.interruptedReason === 'string' ? record.interruptedReason : undefined,
    reusedCount: typeof record.reusedCount === 'number' ? record.reusedCount : 0,
    executedCount: typeof record.executedCount === 'number' ? record.executedCount : 0,
  }
}

/**
 * 打开旧版数据时升级：
 * - 文档 version 1 → 2；
 * - 节点补齐 configVersion；
 * - 旧文档没有 executionPlans 字段，初始化为空；
 * - 执行计划随文档导入时保留。
 */
export function migrateDocument(input: unknown): {
  document: WorkflowDocument
  upgraded: boolean
  warnings: string[]
} {
  const record = asRecord(input)
  const warnings: string[] = []
  if (!record || !Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new Error('JSON 缺少 nodes 或 edges，不是有效的流程文件')
  }
  const legacyVersion = typeof record.version === 'number' ? record.version : 1
  const upgraded = legacyVersion < 2
  const nodes = (record.nodes as unknown[]).map((raw) => {
    const node = raw as WorkflowNode
    if (!node.data) node.data = {} as WorkflowNode['data']
    if (typeof node.data.configVersion !== 'number') node.data.configVersion = 1
    if (!node.data.config || typeof node.data.config !== 'object') node.data.config = {}
    if (typeof node.data.status !== 'string') node.data.status = 'idle'
    return node
  })
  const edges = (record.edges as WorkflowEdge[]).map((edge) => {
    if (!edge.data || !edge.data.portType) edge.data = { ...(edge.data ?? {}), portType: 'dataset' }
    return edge
  })
  const plans = Array.isArray(record.executionPlans)
    ? record.executionPlans.map((item, index) => asPlan(item, index)).filter((item): item is ExecutionPlan => item !== null)
    : []
  if ((record.executionPlans as unknown) && plans.length === 0) {
    warnings.push('执行计划字段无法识别，已忽略')
  }
  const document: WorkflowDocument = {
    version: 2,
    name: typeof record.name === 'string' ? record.name : '未命名流程',
    nodes,
    edges,
    executionPlans: plans,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
  }
  if (upgraded) warnings.push(`已从 v${legacyVersion} 升级到 v2：补齐配置版本与执行计划字段`)
  return { document, upgraded, warnings }
}

/** 导入计划后，用计划里的成功节点运行记录重建结果缓存，使这些结果可直接复用 */
export function resultsFromPlans(plans: ExecutionPlan[]): Map<string, NodeResult> {
  const results = new Map<string, NodeResult>()
  plans
    .filter((plan) => plan.status === 'success')
    .forEach((plan) => {
      const nodeById = new Map(plan.nodes.map((spec) => [spec.nodeId, spec]))
      plan.layers.forEach((layer) => {
        layer.forEach((nodeId) => {
          const run = plan.runs[nodeId]
          const spec = nodeById.get(nodeId)
          if (!run || run.status !== 'success' || !spec) return
          results.set(nodeId, {
            nodeId,
            configVersion: spec.configVersion,
            inputKeys: spec.inputKeys,
            duration: run.duration ?? 0,
            rows: run.rows ?? 0,
            planId: plan.id,
            ranAt: run.finishedAt ?? plan.finishedAt ?? plan.createdAt,
          })
        })
      })
    })
  return results
}
