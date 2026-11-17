import type { AgentRow, AgentStatus, BgRow, BgStatus, Call } from '../types'

const CALLS_KEPT = 10
const ROWS_KEPT = 200
const BG_KEPT = 30
const MONITOR_GRACE_MS = 60_000
export const STALL_MS = 3 * 60_000
export const LINGER_MS = 30_000
const GONE_AFTER_MS = 10_000

export const isLive = (row: AgentRow) => row.status === 'running' || row.status === 'waiting' || row.status === 'idle'

export function spawned(rows: readonly AgentRow[], start: Pick<AgentRow, 'id' | 'type' | 'description' | 'isBackground' | 'startedAt'> & Partial<AgentRow>): AgentRow[] {
  if (rows.some(r => r.id === start.id)) return rows.map(r => (r.id === start.id ? { ...r, ...start, startedAt: r.startedAt } : r))
  const row: AgentRow = { status: 'running', lastAt: start.startedAt, steps: 0, ctxTokens: 0, outTokens: 0, costUsd: 0, toolCount: 0, errorCount: 0, calls: [], ...start }
  return [...rows, row].slice(-ROWS_KEPT)
}

function patch(rows: readonly AgentRow[], id: string, change: (row: AgentRow) => AgentRow): AgentRow[] {
  return rows.map(r => (r.id === id ? change(r) : r))
}

const revive = (row: AgentRow): Partial<AgentRow> => (isLive(row) ? {} : { status: 'running', endedAt: undefined })

export function toolStarted(rows: readonly AgentRow[], id: string, call: Omit<Call, 'endedAt' | 'isError'>): AgentRow[] {
  return patch(rows, id, r => ({ ...r, ...revive(r), lastAt: call.at, toolCount: r.toolCount + 1, calls: [...r.calls, call].slice(-CALLS_KEPT) }))
}

export function toolEnded(rows: readonly AgentRow[], id: string, callId: string, isError: boolean, at: number): AgentRow[] {
  return patch(rows, id, r => ({
    ...r,
    lastAt: at,
    errorCount: r.errorCount + (isError ? 1 : 0),
    calls: r.calls.map(c => (c.id === callId ? { ...c, endedAt: at, isError } : c)),
    approval: r.approval?.callId === callId ? undefined : r.approval,
  }))
}

export function approvalAsked(rows: readonly AgentRow[], id: string, approval: NonNullable<AgentRow['approval']>): AgentRow[] {
  return patch(rows, id, r => ({ ...r, approval }))
}

export function stepped(rows: readonly AgentRow[], id: string, step: { model: string; effort?: string | number; at: number }): AgentRow[] {
  return patch(rows, id, r => ({ ...r, ...revive(r), model: step.model, effort: step.effort === undefined ? r.effort : String(step.effort), steps: r.steps + 1, lastAt: step.at }))
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** USD per million tokens (input, output, cache read) by model id; first match wins. */
const PRICES: [RegExp, number, number, number][] = [
  [/(fable|mythos)-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus/, 5, 25, 0.5],
  [/sonnet-4/, 3, 15, 0.3],
  [/sonnet/, 2, 10, 0.2],
  [/haiku-5-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
]

/** Estimated USD for one response at list prices, cache writes priced as 1-hour writes (twice input); 0 for an unknown model. */
export function stepCost(model: string, u: Usage): number {
  const price = PRICES.find(([re]) => re.test(model))
  if (!price) return 0
  const [, input, output, read] = price
  return (u.input_tokens * input + u.output_tokens * output + u.cache_read_input_tokens * read + u.cache_creation_input_tokens * input * 2) / 1e6
}

export function stepUsage(rows: readonly AgentRow[], id: string, u: Usage | null, stop: string | null, at: number, usd = 0): AgentRow[] {
  return patch(rows, id, r => ({
    ...r,
    lastAt: at,
    costUsd: r.costUsd + usd,
    ctxTokens: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : r.ctxTokens,
    outTokens: r.outTokens + (u?.output_tokens ?? 0),
    hitMaxTokens: r.hitMaxTokens || stop === 'max_tokens',
  }))
}

export function completed(rows: readonly AgentRow[], id: string, reason: string, answer: string, at: number): AgentRow[] {
  const status: AgentStatus = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
  return patch(rows, id, r => ({ ...r, status, endedAt: at, lastAt: at, answer: answer || r.answer, calls: r.calls.map(c => (c.endedAt ? c : { ...c, endedAt: at })) }))
}

const FROM_LIST: Record<string, AgentStatus> = {
  pending: 'running', running: 'running', waiting: 'waiting', idle: 'idle', completed: 'done', failed: 'failed', killed: 'stopped',
}

/** Folds in the engine's own list: agents started before the mod loaded, and status changes no hook saw (a TaskStop).
 *  Workflow agents are not on that list, so they end only through their own turn.complete. */
export function synced(rows: AgentRow[], list: readonly { id: string; type: string; description: string; status: string; parentId?: string; name?: string }[], now: number, missingSince: Map<string, number>): AgentRow[] {
  let next = rows
  for (const one of list) {
    const status = FROM_LIST[one.status] ?? 'running'
    const held = next.find(r => r.id === one.id)
    if (!held) {
      next = spawned(next, { id: one.id, type: one.type, description: one.description, name: one.name, parentId: one.parentId, isBackground: true, startedAt: now, status, ...(isLive({ status } as AgentRow) ? {} : { endedAt: now }) })
      continue
    }
    if (held.status !== status && isLive(held)) next = patch(next, one.id, r => ({ ...r, status, endedAt: isLive({ ...r, status }) ? undefined : (r.endedAt ?? now) }))
  }
  const listed = new Set(list.map(one => one.id))
  for (const r of next) {
    if (!isLive(r) || listed.has(r.id) || r.workflowRunId) {
      missingSince.delete(r.id)
      continue
    }
    const since = missingSince.get(r.id) ?? now
    missingSince.set(r.id, since)
    if (now - since >= GONE_AFTER_MS) next = patch(next, r.id, x => ({ ...x, status: 'stopped', endedAt: now }))
  }
  return next
}

export function tree(rows: readonly AgentRow[]): { row: AgentRow; depth: number }[] {
  const ids = new Set(rows.map(r => r.id))
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const row of rows) {
      const p = row.parentId && ids.has(row.parentId) ? row.parentId : undefined
      if (p !== parent) continue
      out.push({ row, depth })
      if (depth < 6) walk(row.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** Splits rows into agents outside any workflow and one group per workflow run, in first-seen order. */
export function byRun(rows: readonly AgentRow[]): { loose: AgentRow[]; runs: { runId: string; rows: AgentRow[] }[] } {
  const loose: AgentRow[] = []
  const runs = new Map<string, AgentRow[]>()
  for (const r of rows) {
    if (!r.workflowRunId) loose.push(r)
    else runs.set(r.workflowRunId, [...(runs.get(r.workflowRunId) ?? []), r])
  }
  return { loose, runs: [...runs].map(([runId, list]) => ({ runId, rows: list })) }
}

export function counts(rows: readonly AgentRow[]) {
  let live = 0
  let running = 0
  let idle = 0
  let done = 0
  let failed = 0
  let stopped = 0
  for (const r of rows) {
    if (isLive(r)) live++
    if (r.status === 'running' || r.status === 'waiting') running++
    else if (r.status === 'idle') idle++
    else if (r.status === 'done') done++
    else if (r.status === 'failed') failed++
    else stopped++
  }
  const usd = rows.reduce((sum, r) => sum + r.costUsd, 0)
  const approvals = rows.filter(r => isLive(r) && r.approval).length
  return { live, running, idle, done, failed, stopped, usd, approvals }
}

/** The open call, or how long the agent has been quiet when nothing is open and it has been past STALL_MS. */
export function activity(row: AgentRow, now: number): { text: string; isStalled: boolean; isApproval?: boolean } {
  if (row.approval) return { text: `needs approval ${elapsed(now - row.approval.at)}  ${row.approval.label}`, isStalled: false, isApproval: true }
  const open = [...row.calls].reverse().find(c => !c.endedAt)
  if (open) return { text: `${elapsed(now - open.at)}  ${open.label}`, isStalled: false }
  if (row.status === 'idle') return { text: 'idle, waiting for a message', isStalled: false }
  if (row.status === 'waiting') return { text: 'waiting on background work or a plan approval', isStalled: false }
  const quiet = now - row.lastAt
  if (quiet >= STALL_MS) return { text: `quiet ${elapsed(quiet)}`, isStalled: true }
  return { text: 'thinking', isStalled: false }
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function shortModel(model: string | undefined): string {
  if (!model) return '?'
  const m = /(opus|sonnet|haiku|fable|mythos)[-_ ]?(\d+(?:[-.]\d+)?)?/i.exec(model)
  return m ? `${m[1]!.toLowerCase()}${m[2] ? ` ${m[2].replace('-', '.')}` : ''}` : model
}

export const clip = (text: string, size: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat
}

const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** A short plain-English line for a tool call: the Bash description over the command, a file's name over its path. */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const label =
    tool === 'Bash' ? text('description') || text('command')
    : tool === 'Read' ? `Read ${base(text('file_path'))}`
    : tool === 'Edit' ? `Edit ${base(text('file_path'))}`
    : tool === 'Write' ? `Write ${base(text('file_path'))}`
    : tool === 'Grep' ? `Grep ${text('pattern')}`
    : tool === 'Glob' ? `Glob ${text('pattern')}`
    : tool === 'WebFetch' ? `Fetch ${text('url').replace(/^https?:\/\//, '').split('/')[0]}`
    : tool === 'WebSearch' ? `Search ${text('query')}`
    : tool === 'Agent' ? `Agent ${text('description')}`
    : tool === 'Skill' ? `Skill ${text('skill')}`
    : tool.startsWith('mcp__') ? tool.split('__').slice(1).join(': ')
    : tool
  return clip(label, 44)
}

/** Whole minutes for an idle clock that is redrawn every half minute. */
export function minutes(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Time left until a limit resets: days and hours past a day, else as minutes() has it. */
export function until(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  return h < 24 ? minutes(ms) : `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`
}

export const usd = (n: number) => (n < 10 ? `~$${n.toFixed(2)}` : `~$${Math.round(n)}`)

/** The background task a main-thread tool call started, read from its result text: a shell, a Monitor or a Workflow run. */
export function launched(tool: string, text: string): Omit<BgRow, 'label' | 'startedAt' | 'status' | 'events'> & { summary?: string } | undefined {
  if (tool === 'Bash') {
    const m = /^Command [^\n]*?background[^\n]*? with ID: (\w+)/.exec(text)
    return m ? { id: m[1]!, kind: 'shell' } : undefined
  }
  if (tool === 'Monitor') {
    const m = /^Monitor started \(task (\w+)(?:, expires in (\d+)m)?/.exec(text)
    return m ? { id: m[1]!, kind: 'monitor', expiresInMs: m[2] ? Number(m[2]) * 60_000 : undefined } : undefined
  }
  if (tool === 'Workflow') {
    const id = /Task ID: (\w+)/.exec(text)?.[1]
    if (!id) return undefined
    return { id, kind: 'workflow', runId: /Run ID: (wf_[\w-]+)/.exec(text)?.[1], summary: /Summary: ([^\n]+)/.exec(text)?.[1] }
  }
  return undefined
}

export type Notice = { id: string; status?: BgStatus; isEvent: boolean }

const ENDED: Record<string, BgStatus> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }

/** The task notifications in a delivered prompt: each task's id, how it ended if it did, and whether it is a Monitor event. */
export function notices(text: string): Notice[] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(([, body]) => {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(body!)?.[1]
    if (!id) return []
    const word = /<status>([^<]+)<\/status>/.exec(body!)?.[1]
    const isExpired = /Monitor expired/.test(body!)
    return [{ id, status: isExpired ? 'expired' : word ? (ENDED[word] ?? 'done') : undefined, isEvent: /<event>/.test(body!) }]
  })
}

export const isBgLive = (row: BgRow) => row.status === 'running'

export function bgStarted(list: readonly BgRow[], row: BgRow): BgRow[] {
  return [...list.filter(r => r.id !== row.id), row].slice(-BG_KEPT)
}

export function bgNoticed(list: readonly BgRow[], n: Notice, at: number): BgRow[] {
  return list.map(r => {
    if (r.id !== n.id || !isBgLive(r)) return r
    if (n.status) return { ...r, status: n.status, endedAt: at, events: r.events + (n.isEvent ? 1 : 0) }
    return n.isEvent ? { ...r, events: r.events + 1, lastEventAt: at } : r
  })
}

export function bgStopped(list: readonly BgRow[], id: string, at: number): BgRow[] {
  return list.map(r => (r.id === id && isBgLive(r) ? { ...r, status: 'stopped' as const, endedAt: at } : r))
}

/** Monitors past their stated expiry by a minute, in case the expiry notice never came. */
export function bgExpired(list: readonly BgRow[], now: number): BgRow[] {
  return list.some(r => isBgLive(r) && r.expiresInMs !== undefined && now > r.startedAt + r.expiresInMs + MONITOR_GRACE_MS)
    ? list.map(r => (isBgLive(r) && r.expiresInMs !== undefined && now > r.startedAt + r.expiresInMs + MONITOR_GRACE_MS ? { ...r, status: 'expired' as const, endedAt: now } : r))
    : (list as BgRow[])
}
