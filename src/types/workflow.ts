import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped'

export interface NodeConfig {
  [key: string]: string | number | boolean
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string
  kind: NodeKind
  description: string
  config: NodeConfig
  configVersion: number
  status: RunStatus
  duration?: number
  rows?: number
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

export type PlanNodeRunStatus = 'pending' | 'queued' | 'running' | 'success' | 'error' | 'skipped'
export type PlanStatus = 'running' | 'success' | 'failed'

export interface PlanNodeRecord {
  id: string
  kind: NodeKind
  configVersion: number
  fingerprint: string
  status: PlanNodeRunStatus
  /** 结果是否复用上一轮计划 */
  cached: boolean
  attempts: number
  retries: number
  duration?: number
  rows?: number
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface PlanEdgeRecord {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  portType: PortType
}

export interface PlanStats {
  total: number
  cached: number
  executed: number
  retries: number
  failed: number
  skipped: number
}

export interface ExecutionPlan {
  id: string
  version: 1
  /** 由节点标识、配置版本与连接关系共同决定，用于幂等校验 */
  fingerprint: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  status: PlanStatus
  abortReason?: string
  /** 按依赖深度分层，同层节点并发执行 */
  layers: string[][]
  nodes: PlanNodeRecord[]
  edges: PlanEdgeRecord[]
  stats: PlanStats
}

export interface WorkflowDocument {
  version: 1
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  savedAt: string
  executionPlan?: ExecutionPlan
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
