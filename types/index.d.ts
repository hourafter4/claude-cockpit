export type Call = { id: string; label: string; at: number; endedAt?: number; isError?: boolean }

export type AgentStatus = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped'

export type Approval = { callId: string; label: string; at: number }

export type AgentRow = {
  id: string
  type: string
  description: string
  name?: string
  model?: string
  effort?: string
  parentId?: string
  workflowRunId?: string
  workflowIndex?: number
  isBackground: boolean
  status: AgentStatus
  startedAt: number
  endedAt?: number
  lastAt: number
  steps: number
  ctxTokens: number
  outTokens: number
  costUsd: number
  toolCount: number
  errorCount: number
  calls: Call[]
  answer?: string
  hitMaxTokens?: boolean
  approval?: Approval
}

export type BgKind = 'shell' | 'monitor' | 'workflow'

export type BgStatus = 'running' | 'done' | 'failed' | 'stopped' | 'expired'

export type BgRow = {
  id: string
  kind: BgKind
  label: string
  startedAt: number
  endedAt?: number
  status: BgStatus
  events: number
  lastEventAt?: number
  runId?: string
  expiresInMs?: number
}

export type MainPhase = 'thinking' | 'writing' | 'preparing' | ''

export type MainState = {
  isWorking: boolean
  turnStartedAt: number
  lastEndAt: number
  lastTurnMs: number
  lastRequestAt: number
  model: string
  effort: string
  requests: number
  tools: number
  errors: number
  phase: MainPhase
  preparing: string
  calls: Call[]
  approval?: Approval
}

export type ContextFill = { tokens?: number; window: number; percent?: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = { limits: Limit[]; costUsd?: number }

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      rows: AgentRow[]
      bg: BgRow[]
      selected: string | null
      now: number
      main: MainState
      context: ContextFill | null
      usage: Usage | null
    }
  }
}
