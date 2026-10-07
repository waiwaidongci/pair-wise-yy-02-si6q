import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped'
  | 'stale'
  | 'cancelled'

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

export type PlanStatus = 'pending' | 'running' | 'success' | 'failed' | 'interrupted'

/** 计划中固化的单个节点：节点标识 + 配置版本 */
export interface PlanNodeSpec {
  nodeId: string
  kind: NodeKind
  configVersion: number
  /** 入边关系键（已排序），用于判断连线变更是否影响该节点 */
  inputKeys: string[]
}

/** 计划中固化的连接关系 */
export interface PlanEdgeSpec {
  source: string
  sourceHandle: string | null
  target: string
  targetHandle: string | null
  portType: PortType
  key: string
}

export interface PlanNodeRun {
  nodeId: string
  status: RunStatus
  attempts: number
  duration?: number
  rows?: number
  /** 本次提交直接复用上一次成功结果，未真正重算 */
  cached?: boolean
  error?: string
  startedAt?: string
  finishedAt?: string
}

/** 一次「运行」固化下来的执行计划 */
export interface ExecutionPlan {
  id: string
  formatVersion: 1
  name: string
  /** 由节点标识、配置版本与连接关系算出；同签名重复提交只保留这一条 */
  signature: string
  nodes: PlanNodeSpec[]
  edges: PlanEdgeSpec[]
  /** 拓扑分层：同层节点可并发执行 */
  layers: string[][]
  status: PlanStatus
  runs: Record<string, PlanNodeRun>
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** 中断 / 失败原因 */
  interruptedReason?: string
  reusedCount: number
  executedCount: number
}

/** 节点上一次成功结果，按节点标识保存，供后续计划复用 */
export interface NodeResult {
  nodeId: string
  configVersion: number
  inputKeys: string[]
  duration: number
  rows: number
  planId: string
  ranAt: string
}

export interface WorkflowDocument {
  version: 2
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  executionPlans: ExecutionPlan[]
  savedAt: string
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
