import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { AgentRow, BgRow, Call, MainState } from '../types'
import {
  LINGER_MS,
  activity,
  approvalAsked,
  bgExpired,
  bgNoticed,
  bgStarted,
  bgStopped,
  byRun,
  clip,
  completed,
  counts,
  elapsed,
  isBgLive,
  isLive,
  launched,
  minutes,
  notices,
  shortModel,
  spawned,
  stepCost,
  stepUsage,
  stepped,
  synced,
  tokens,
  toolEnded,
  toolLabel,
  toolStarted,
  tree,
  until,
  usd,
} from './agents'

const PANE = 'cockpit'
const TITLE = 'Cockpit'
const PANE_COLUMNS = 64
const TICK_MS = 1_000
const SYNC_MS = 2_000
const IDLE_REDRAW_MS = 30_000
const CACHE_TTL_MS = 60 * 60_000
const MAIN_CALLS_KEPT = 8
const SKIP_TOOLS = new Set(['ToolSearch', 'SubagentHandback'])
const ACCENT = '#c792ea'
const WARNING = '#ffcb6b'
const ERROR = '#ff5555'
const SUCCESS = '#50fa7b'
const SUGGESTION = '#8be9fd'
const BAND = '#44475a'
const BAND_TEXT = '#f8f8f2'

const IDLE_MAIN: MainState = {
  isWorking: false, turnStartedAt: 0, lastEndAt: 0, lastTurnMs: 0, lastRequestAt: 0, model: '', effort: '',
  requests: 0, tools: 0, errors: 0, phase: '', preparing: '', calls: [],
}

const rows = atom({ plugin: 'cockpit', key: 'rows' } as const, [])
const bg = atom({ plugin: 'cockpit', key: 'bg' } as const, [])
const selected = atom({ plugin: 'cockpit', key: 'selected' } as const, null)
const clockNow = atom({ plugin: 'cockpit', key: 'now' } as const, 0)
const main = atom({ plugin: 'cockpit', key: 'main' } as const, IDLE_MAIN)
const context = atom({ plugin: 'cockpit', key: 'context' } as const, null)
const quota = atom({ plugin: 'cockpit', key: 'usage' } as const, null)

const LIMIT_WORD: Record<string, string> = { five_hour: 'session', seven_day: 'week', spend_limit: 'spend' }

const BG_WORD: Record<BgRow['kind'], string> = { shell: 'shell', monitor: 'monitor', workflow: 'workflow' }
const BG_END: Record<string, { glyph: string; color?: string; dimColor?: boolean }> = {
  done: { glyph: '✓', color: SUCCESS },
  failed: { glyph: '✗', color: ERROR },
  stopped: { glyph: '■', dimColor: true },
  expired: { glyph: '⌛', dimColor: true },
}

const GLYPH: Record<string, { glyph: string; color?: string; dimColor?: boolean }> = {
  running: { glyph: '●', color: WARNING },
  waiting: { glyph: '◐', color: WARNING },
  idle: { glyph: '◉', color: SUGGESTION },
  done: { glyph: '✓', color: SUCCESS },
  failed: { glyph: '✗', color: ERROR },
  stopped: { glyph: '■', dimColor: true },
}

function bar(percent: number, width = 12) {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${'█'.repeat(full)}${'░'.repeat(width - full)}`
}

function agentMeta(row: AgentRow, now: number) {
  return [
    elapsed((row.endedAt ?? now) - row.startedAt),
    `${row.toolCount} tools`,
    row.errorCount ? `${row.errorCount} err` : undefined,
    row.ctxTokens ? `ctx ${tokens(row.ctxTokens)}` : undefined,
    row.costUsd ? usd(row.costUsd) : undefined,
    [shortModel(row.model), row.effort].filter(Boolean).join(' '),
    row.type,
  ].filter(Boolean).join(' · ')
}

/** What the main thread is doing this second: the open tool call, else the phase of the response being streamed. */
function mainNow(m: MainState, now: number): string {
  if (m.approval) return `needs approval ${elapsed(now - m.approval.at)}  ${m.approval.label}`
  const open = [...m.calls].reverse().find(c => !c.endedAt)
  if (open) {
    const more = m.calls.filter(c => !c.endedAt).length - 1
    return `${elapsed(now - open.at)}  ${open.label}${more > 0 ? ` (+${more} more)` : ''}`
  }
  if (m.phase === 'preparing') return `preparing ${m.preparing} call`
  if (m.phase === 'writing') return 'writing reply'
  return 'thinking'
}

async function setRows($: EngineInterface, change: (list: AgentRow[]) => AgentRow[]) {
  return update($, rows, list => change([...list]))
}

/** A toast in the terminal and a native notification for when the person is in another window. */
function alert($: EngineInterface, text: string) {
  $.ui.toast(text)
  void $.ui.notify(text, { title: 'cockpit' }).catch(() => undefined)
}

/** The agents live since the live count was last zero, for the all-finished toast. */
const batch = new Set<string>()

async function announce($: EngineInterface, before: readonly AgentRow[], after: readonly AgentRow[]) {
  const was = new Map(before.map(r => [r.id, r]))
  for (const r of after) {
    const old = was.get(r.id)
    if (!old || !isLive(old) || isLive(r)) continue
    if (r.status === 'failed') alert($, `✗ ${r.type} failed: ${r.description}`)
    else if (r.status === 'done' && r.isBackground) $.ui.toast(`✓ ${r.description} done (${elapsed((r.endedAt ?? 0) - r.startedAt)})`)
  }
  for (const r of [...before, ...after]) if (isLive(r)) batch.add(r.id)
  if (counts(before).live > 0 && counts(after).live === 0) {
    if (batch.size > 1) alert($, `cockpit: all ${batch.size} agents finished`)
    batch.clear()
  }
}

async function transition($: EngineInterface, change: (list: AgentRow[]) => AgentRow[]) {
  const before = await read($, rows)
  const after = await setRows($, change)
  await announce($, before, after)
}

function announceBg($: EngineInterface, before: readonly BgRow[], after: readonly BgRow[]) {
  const was = new Map(before.map(r => [r.id, r]))
  for (const r of after) {
    const old = was.get(r.id)
    if (!old || !isBgLive(old) || isBgLive(r)) continue
    const text = `${BG_END[r.status]?.glyph ?? '•'} ${BG_WORD[r.kind]} ${r.status}: ${r.label} (${elapsed((r.endedAt ?? 0) - r.startedAt)})`
    if (r.status === 'done' || r.status === 'failed') alert($, text)
    else $.ui.toast(text)
  }
}

async function bgChange($: EngineInterface, change: (list: BgRow[]) => BgRow[]) {
  const before = await read($, bg)
  const after = await update($, bg, list => change([...list]))
  announceBg($, before, after)
}

async function stop($: EngineInterface, row: AgentRow) {
  try {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: row.id })
    $.ui.toast(r.isError ? `cockpit: could not stop ${row.description}: ${r.text}` : `cockpit: stopped ${row.description}`)
  } catch (err) {
    $.ui.toast(`cockpit: could not stop ${row.description} (${String(err)})`)
  }
}

async function note($: EngineInterface, row: AgentRow, text: string) {
  const sent = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: `[note from the user, via cockpit] ${text}` }] }, agentId: row.id })
    .catch((err: unknown) => ({ deny: String(err) }))
  $.ui.toast('deny' in sent && sent.deny ? `cockpit: note not delivered (${sent.deny})` : `cockpit: note sent to ${row.description}`)
}

async function isPaneShown($: EngineInterface) {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)
}

let isTicking = false
let callSeq = 0
const missingSince = new Map<string, number>()
let syncedAt = 0

async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const list = await read($, rows)
    const m = await read($, main)
    const drawn = await read($, clockNow)
    const lastEnd = Math.max(0, ...list.map(r => r.endedAt ?? 0))
    const bgList = await read($, bg)
    if (bgExpired(bgList, now) !== bgList) await bgChange($, held => bgExpired(held, now))
    const isBusy = m.isWorking || list.some(r => r.status === 'running' || r.status === 'waiting') || bgList.some(isBgLive) || drawn - lastEnd < LINGER_MS
    if (!isBusy && now - drawn < IDLE_REDRAW_MS) return
    await update($, clockNow, () => now)
    if (!list.some(isLive) || now - syncedAt < SYNC_MS) return
    syncedAt = now
    const engine = await $.agent.list().catch(() => undefined)
    if (!engine) return
    const current = await read($, rows)
    const next = synced(current, engine, now, missingSince)
    if (next !== current) await transition($, held => (held === current ? next : synced(held, engine, now, missingSince)))
  } finally {
    isTicking = false
  }
}

export const register: Register = on => {
  let hasAutoOpened = false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'cockpit', description: 'Sidebar: what main and every subagent are doing', argumentHint: '[clear]' })
    const now = await $.clock.now()
    const usage = await $.session.usage()
    await update($, context, () => usage.context)
    await update($, quota, () => ({ limits: usage.rateLimits, costUsd: usage.cost?.usd }))
    const engine = await $.agent.list().catch(() => [])
    if (engine.length) await setRows($, held => synced(held, engine, now, missingSince))
    $.clock.every(TICK_MS, () => void tick($))
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await update($, context, () => e.context)
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) await update($, quota, () => ({ limits: e.rateLimits, costUsd: e.cost?.usd }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, main, m => ({ ...m, isWorking: true, turnStartedAt: now, requests: 0, tools: 0, errors: 0, phase: 'thinking' as const, preparing: '', calls: [] }))
      await update($, clockNow, () => now)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) {
      const now = await $.clock.now()
      await update($, clockNow, () => now)
      await setRows($, held =>
        spawned(held, {
          id: result.agentId!,
          type: e.subagentType || 'general-purpose',
          description: e.description,
          name: e.name,
          model: result.model,
          parentId: e.parentAgentId,
          workflowRunId: e.workflow?.runId || undefined,
          workflowIndex: e.workflow?.agentIndex,
          isBackground: e.background,
          startedAt: now,
        }),
      )
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) {
      const now = await $.clock.now()
      await update($, main, m => ({ ...m, model: e.model, effort: e.effort === undefined ? m.effort : String(e.effort), requests: m.requests + 1, lastRequestAt: now, phase: 'thinking' as const, preparing: '' }))
      const stream = next(e)
      let phase: MainState['phase'] = 'thinking'
      for (;;) {
        const step = await stream.next()
        if (step.done) return step.value
        const c = step.value
        const to: MainState['phase'] = c.kind === 'text' ? 'writing' : c.kind === 'thinking' ? 'thinking' : c.kind === 'tool' ? 'preparing' : phase
        if (to !== phase) {
          phase = to
          const name = c.kind === 'tool' ? String(c.name) : ''
          await update($, main, m => ({ ...m, phase: to, preparing: name || m.preparing }))
        }
        yield c
      }
    }
    const isOurs = (await read($, rows)).some(r => r.id === id)
    if (isOurs) {
      const at = await $.clock.now()
      await setRows($, held => stepped(held, id, { model: e.model, effort: e.effort, at }))
    }
    const r = yield* next(e)
    if (isOurs) {
      const at = await $.clock.now()
      const cost = r.usage ? stepCost(r.usage.model || e.model, r.usage) : 0
      await setRows($, held => stepUsage(held, id, r.usage, r.stopReason, at, cost))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (SKIP_TOOLS.has(String(e.tool))) return next(e)
    const at = await $.clock.now()
    const callId = e.tool_use_id ?? `${id ?? 'main'}:${at}:${++callSeq}`
    const label = toolLabel(String(e.tool), e as unknown as Record<string, unknown>)
    const isMain = id === undefined
    const isAgent = !isMain && (await read($, rows)).some(r => r.id === id)
    if (!isMain && !isAgent) return next(e)
    if (isMain) await update($, main, m => ({ ...m, tools: m.tools + 1, calls: [...m.calls, { id: callId, label, at }].slice(-MAIN_CALLS_KEPT) }))
    else await setRows($, held => toolStarted(held, id!, { id: callId, label, at }))
    let isError = true
    try {
      const ran = await next(e)
      isError = Boolean(ran.deny || ran.isError)
      if (isMain && !isError) await noteLaunch($, e as unknown as Record<string, unknown>, ran.text ?? '', at)
      return ran
    } finally {
      const end = await $.clock.now()
      if (isMain) {
        await update($, main, m => ({
          ...m,
          errors: m.errors + (isError ? 1 : 0),
          calls: m.calls.map((c: Call) => (c.id === callId ? { ...c, endedAt: end, isError } : c)),
          approval: m.approval?.callId === callId ? undefined : m.approval,
          phase: m.calls.some(c => c.id !== callId && !c.endedAt) ? m.phase : 'thinking',
        }))
      } else {
        await setRows($, held => toolEnded(held, id!, callId, isError, end))
      }
    }
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask' || !e.tool_use_id) return r
    const approval = { callId: e.tool_use_id, label: toolLabel(String(e.tool), (e.input ?? {}) as Record<string, unknown>), at: await $.clock.now() }
    const id = e.agentId
    if (id === undefined) await update($, main, m => ({ ...m, approval }))
    else if ((await read($, rows)).some(row => row.id === id)) await setRows($, held => approvalAsked(held, id, approval))
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const found = notices(e.text)
      if (found.length) {
        const at = await $.clock.now()
        await bgChange($, held => found.reduce((list, n) => bgNoticed(list, n, at), held))
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    const at = await $.clock.now()
    if (id === undefined) {
      await update($, main, m => ({ ...m, isWorking: false, lastEndAt: at, lastTurnMs: e.durationMs, phase: '' as const, calls: m.calls.map(c => (c.endedAt ? c : { ...c, endedAt: at })) }))
      await update($, clockNow, () => at)
    } else if ((await read($, rows)).some(r => r.id === id)) {
      await update($, clockNow, () => at)
      await transition($, held => completed(held, id, e.reason, e.answer, at))
    }
    return result
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await setRows($, held => held.filter(isLive))
      await update($, bg, held => held.filter(isBgLive))
      return { text: 'cockpit: cleared finished agents and background tasks.' }
    }
    const now = await $.clock.now()
    await update($, clockNow, () => now)
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    return { text: opened.isPlaced ? 'cockpit: open.' : `cockpit: not shown (${opened.reason})` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!hasAutoOpened && e.viewport?.isFullscreen === true) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    }
    if (e.props.hasSurvey || (await isPaneShown($))) return rest
    const m = await read($, main)
    const list = await read($, rows)
    const bgLive = (await read($, bg)).filter(isBgLive).length
    if (!m.isWorking && m.lastEndAt === 0 && !list.length && !bgLive) return rest
    const now = Math.max(await read($, clockNow), m.lastRequestAt, m.turnStartedAt)
    const ctx = await read($, context)
    const { running, idle, failed, approvals } = counts(list)
    const asking = approvals + (m.approval ? 1 : 0)
    const stalled = list.filter(r => isLive(r) && activity(r, now).isStalled).length
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        <Text key="cockpit" wrap="truncate">
          {m.isWorking
            ? <Text color={ACCENT}>{`● main ${elapsed(now - m.turnStartedAt)}`}</Text>
            : <Text dimColor>{`○ main idle ${minutes(now - m.lastEndAt)}${ctx?.percent === undefined ? '' : ` · ctx ${Math.round(ctx.percent)}%`}`}</Text>}
          {list.length > 0 && <Text dimColor>{' · '}</Text>}
          {list.length > 0 && <Text color={running ? WARNING : undefined} dimColor={!running}>{`agents ${running} running`}</Text>}
          {idle > 0 && <Text color={SUGGESTION}>{` · ${idle} idle`}</Text>}
          {stalled > 0 && <Text color={WARNING}>{` · ${stalled} stalled`}</Text>}
          {failed > 0 && <Text color={ERROR}>{` · ${failed} failed`}</Text>}
          {bgLive > 0 && <Text color={WARNING}>{` · ${bgLive} bg`}</Text>}
          {asking > 0 && <Text color={ERROR}>{` · ${asking} needs approval`}</Text>}
          {m.isWorking && <Text>{`  │  ${mainNow(m, now)}`}</Text>}
          <Text dimColor>{'  /cockpit'}</Text>
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  on('ui.open', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    $.ui.invalidate('ui.render')
    return r
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    $.ui.invalidate('ui.render')
    return r
  })
}

/** Records the background task a main-thread call started, and marks one TaskStop ended. */
async function noteLaunch($: EngineInterface, input: Record<string, unknown>, text: string, at: number) {
  const tool = String(input.tool)
  if (tool === 'TaskStop') {
    const id = String(input.task_id ?? input.shell_id ?? '')
    if (id) await bgChange($, held => bgStopped(held, id, at))
    return
  }
  const found = launched(tool, text)
  if (!found) return
  const { summary, ...rest } = found
  const named = typeof input.description === 'string' && input.description ? input.description : typeof input.command === 'string' ? input.command : ''
  const label = clip(summary || named || tool, 80)
  await bgChange($, held => bgStarted(held, { ...rest, label, startedAt: at, status: 'running', events: 0 }))
}

const MESSAGE_TTL_MS = 5_000
const lastMessages = new Map<string, { at: number; text?: string }>()

async function lastMessage($: EngineInterface, row: AgentRow, now: number) {
  const held = lastMessages.get(row.id)
  if (held && now - held.at < MESSAGE_TTL_MS) return held.text
  const messages = await $.session.messages({ agentId: row.id }).catch(() => [])
  const text = Array.isArray(messages) ? messages.filter(msg => msg.role === 'assistant' && msg.text).at(-1)?.text : undefined
  lastMessages.set(row.id, { at: now, text })
  return text
}

async function drawPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const m = await read($, main)
  const list = await read($, rows)
  const pick = await read($, selected)
  const ctx = await read($, context)
  const now = Math.max(await read($, clockNow), m.lastRequestAt, m.turnStartedAt, ...list.map(r => r.lastAt))
  const viewing = e.props.view?.agentId
  const { running, idle, done, failed, stopped } = counts(list)
  const width = Math.max(24, e.props.bodyColumns - 2)

  const rule = (key: string, title: string, extra?: string) => (
    <Text key={key} wrap="truncate" color={BAND_TEXT} backgroundColor={BAND}>
      <Text bold color={ACCENT}>{` ${title}`}</Text>
      {(extra ? `  ${extra}` : '').padEnd(Math.max(0, width - title.length - 1))}
    </Text>
  )
  const field = (key: string, label: string, body: RenderElement) => (
    <Text key={key} wrap="truncate">
      <Text dimColor>{label.padEnd(7)}</Text>
      {body}
    </Text>
  )

  const cacheLeft = m.lastRequestAt ? m.lastRequestAt + CACHE_TTL_MS - now : 0
  const pct = ctx?.percent
  const finishedCalls = [...m.calls].reverse().filter(c => c.endedAt).slice(0, 6)
  const mainLines = [
    rule('main-title', 'MAIN', viewing ? 'viewing an agent' : undefined),
    field('main-state', 'state', m.isWorking
      ? <Text color={ACCENT}>{`● working ${elapsed(now - m.turnStartedAt)}`}</Text>
      : <Text dimColor>{m.lastEndAt ? `○ idle ${minutes(now - m.lastEndAt)} · last turn ${elapsed(m.lastTurnMs)}` : '○ no turn yet'}</Text>),
    m.model && field('main-model', 'model', <Text>{[shortModel(m.model), m.effort, `request ${m.requests}`, `${m.tools} tools`].filter(Boolean).join(' · ')}</Text>),
    m.errors > 0 && field('main-errors', 'errors', <Text color={ERROR}>{`${m.errors} failed this turn`}</Text>),
    ctx?.tokens !== undefined && field('main-ctx', 'ctx', (
      <Text>
        <Text color={pct !== undefined && pct >= 90 ? ERROR : pct !== undefined && pct >= 80 ? WARNING : undefined}>{bar(pct ?? 0)}</Text>
        <Text dimColor>{`  ${pct === undefined ? '' : `${Math.round(pct)}%  `}${tokens(ctx.tokens)}/${tokens(ctx.window)}`}</Text>
      </Text>
    )),
    m.lastRequestAt > 0 && field('main-cache', 'cache', cacheLeft > 0 ? <Text dimColor>{`warm, ~${Math.ceil(cacheLeft / 60_000)}m left (1h assumed)`}</Text> : <Text color={WARNING}>cold</Text>),
    m.isWorking && field('main-now', 'now', <Text bold color={m.approval ? ERROR : undefined}>{mainNow(m, now)}</Text>),
    ...finishedCalls.map((c, n) => field(`main-call:${c.id}`, n === 0 ? 'last' : '', <Text color={c.isError ? ERROR : undefined} dimColor={!c.isError}>{`${c.isError ? '✗' : '✓'} ${c.label}`}</Text>)),
  ].filter(Boolean)

  const detail = async (row: AgentRow) => {
    const said = row.answer ?? (await lastMessage($, row, now))
    return (
      <Box key="detail" flexDirection="column" marginLeft={2} marginBottom={1}>
        <Text key="meta" dimColor wrap="wrap">
          {[row.model, row.effort && `effort ${row.effort}`, row.isBackground ? 'background' : 'foreground', `${row.steps} requests`, `ctx ${tokens(row.ctxTokens)}`, `${tokens(row.outTokens)} out`, row.costUsd ? `${usd(row.costUsd)} est.` : undefined, row.workflowRunId && `${row.workflowRunId} #${row.workflowIndex ?? '?'}`, row.hitMaxTokens ? 'HIT max_tokens' : undefined, `id ${row.id}`].filter(Boolean).join(' · ')}
        </Text>
        {[...row.calls].reverse().slice(0, 8).map(c => (
          <Text key={c.id} wrap="truncate" color={c.isError ? ERROR : undefined} dimColor={Boolean(c.endedAt) && !c.isError}>
            {`${c.endedAt ? (c.isError ? '✗' : '✓') : '…'} ${c.endedAt ? '' : `${elapsed(now - c.at)}  `}${c.label}`}
          </Text>
        ))}
        {said && (
          <Box key="said" flexDirection="column" marginTop={1}>
            <Text key="label" bold>{row.answer ? 'Answer' : 'Last message'}</Text>
            <Text key="text" wrap="wrap">{said.length > 700 ? `${said.slice(0, 699)}…` : said}</Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          {viewing === row.id
            ? <Button key={`main:${row.id}`} hotkey="m" onPress={() => void $.ui.view({})}>Back to main</Button>
            : <Button key={`view:${row.id}`} hotkey="v" variant="primary" onPress={() => void $.ui.view({ agentId: row.id })}>View transcript</Button>}
          {isLive(row) && <Button key={`stop:${row.id}`} hotkey="s" onPress={() => void stop($, row)}>Stop</Button>}
        </Box>
        {Input && isLive(row) && (
          <Input key={`note:${row.id}`} placeholder="send this agent a note…" submitLabel="Send" onSubmit={(value: string) => void (value.trim() && note($, row, value.trim()))} />
        )}
      </Box>
    )
  }

  const block = async (row: AgentRow, depth: number) => {
    const g = GLYPH[row.status] ?? { glyph: '?' }
    const isOpen = pick === row.id
    const act = activity(row, now)
    const pad = '  '.repeat(depth)
    const room = Math.max(12, width - pad.length - 14)
    return (
      <Box key={row.id} flexDirection="column" marginBottom={isLive(row) ? 1 : 0}>
        <Box key="line" flexDirection="row">
          <Text color={g.color} dimColor={g.dimColor}>{`${pad}${g.glyph} `}</Text>
          <Button key={`row:${row.id}`} plain onPress={() => void update($, selected, held => (held === row.id ? null : row.id))}>
            <Text bold={isLive(row)} dimColor={!isLive(row)}>{clip(row.description, room)}</Text>
            {!isLive(row) ? <Text dimColor>{`  ${elapsed((row.endedAt ?? now) - row.startedAt)}`}</Text> : ''}
            {viewing === row.id ? <Text color={SUGGESTION}>{'  (viewing)'}</Text> : ''}
          </Button>
        </Box>
        {isLive(row) && <Text key="meta" dimColor wrap="truncate">{`${pad}  ${agentMeta(row, now)}`}</Text>}
        {isLive(row) && !isOpen && (
          <Text key="now" wrap="truncate" color={act.isApproval ? ERROR : act.isStalled ? WARNING : undefined} dimColor={!act.isStalled && !act.isApproval}>{`${pad}  ↳ ${act.text}`}</Text>
        )}
        {isOpen && (await detail(row))}
      </Box>
    )
  }

  const bgList = await read($, bg)
  const { loose, runs } = byRun(list)
  const liveBlocks: RenderElement[] = []
  const doneBlocks: RenderElement[] = []
  for (const { row, depth } of tree(loose)) (isLive(row) ? liveBlocks : doneBlocks).push(await block(row, isLive(row) ? depth : 0))
  for (const run of runs) {
    const c = counts(run.rows)
    const title = bgList.find(b => b.runId === run.runId)?.label ?? run.runId
    const tally = [`${c.running} running`, c.idle ? `${c.idle} idle` : undefined, `${c.done} done`, c.failed ? `${c.failed} failed` : undefined, c.stopped ? `${c.stopped} stopped` : undefined, c.usd ? usd(c.usd) : undefined].filter(Boolean).join(' · ')
    const header = (
      <Text key={`run:${run.runId}`} wrap="truncate">
        <Text color={c.live ? WARNING : undefined} dimColor={!c.live}>{`◆ ${clip(title, Math.max(12, width - tally.length - 4))}`}</Text>
        <Text dimColor>{`  ${tally}`}</Text>
      </Text>
    )
    if (!c.live) {
      doneBlocks.push(header)
      continue
    }
    liveBlocks.push(header)
    for (const row of run.rows.filter(isLive)) liveBlocks.push(await block(row, 1))
  }
  const totals = counts(list)
  const summary = [
    `${running} running`,
    idle ? `${idle} idle` : undefined,
    `${done} done`,
    failed ? `${failed} failed` : undefined,
    stopped ? `${stopped} stopped` : undefined,
    totals.usd ? `${usd(totals.usd)} est.` : undefined,
  ].filter(Boolean).join(' · ')
  const bgLive = bgList.filter(isBgLive)
  const bgDone = bgList.filter(r => !isBgLive(r)).slice(-5).reverse()
  const bgLines = bgList.length === 0 ? [] : [
    <Text key="bg-gap" dimColor>{' '}</Text>,
    rule('bg-title', 'BACKGROUND', `${bgLive.length} running`),
    ...bgLive.map(r => (
      <Text key={`bg:${r.id}`} wrap="truncate">
        <Text color={WARNING}>{`● ${BG_WORD[r.kind].padEnd(8)}`}</Text>
        <Text>{`${elapsed(now - r.startedAt).padEnd(7)} ${r.label}`}</Text>
        {r.kind === 'monitor' && <Text dimColor>{`  ${r.events} events${r.lastEventAt ? `, last ${elapsed(now - r.lastEventAt)} ago` : ''}`}</Text>}
      </Text>
    )),
    ...bgDone.map(r => {
      const g = BG_END[r.status] ?? { glyph: '•' }
      return (
        <Text key={`bg:${r.id}`} wrap="truncate" dimColor={!g.color}>
          <Text color={g.color} dimColor={g.dimColor}>{`${g.glyph} ${BG_WORD[r.kind].padEnd(8)}`}</Text>
          <Text dimColor>{`${elapsed((r.endedAt ?? now) - r.startedAt).padEnd(7)} ${r.label}`}</Text>
        </Text>
      )
    }),
  ]

  const u = await read($, quota)
  const limits = (u?.limits ?? []).map((l, n) => {
    const left = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
    return {
      l,
      word: `${n ? '   ' : ''}${LIMIT_WORD[l.kind] ?? l.kind} `,
      tail: ` ${Math.round(l.percentUsed)}%${left > 0 ? ` · ${until(left)}` : ''}`,
    }
  })
  const costText = u?.costUsd === undefined ? '' : `${usd(u.costUsd)} this session, est. · no plan limits reported`
  // Spaces to the edge, so the line paints over the row it is pinned on.
  const fill = ' '.repeat(Math.max(0, width - 7 - (limits.length ? limits.reduce((sum, p) => sum + p.word.length + 5 + p.tail.length, 0) : costText.length)))
  const usageLine = limits.length
    ? field('usage', 'usage', (
      <Text>
        {limits.map(({ l, word, tail }) => (
          <Text key={l.kind}>
            <Text dimColor>{word}</Text>
            <Text color={l.percentUsed >= 90 ? ERROR : l.percentUsed >= 80 ? WARNING : undefined}>{bar(l.percentUsed, 5)}</Text>
            <Text dimColor>{tail}</Text>
          </Text>
        ))}
        {fill}
      </Text>
    ))
    : costText ? field('usage', 'usage', <Text dimColor>{`${costText}${fill}`}</Text>) : undefined
  // Docked, the line is pinned to the window's bottom row and paints over what scrolls beneath it; inline the frame fits the tree, so it just ends it.
  const bodyRows = e.props.scroll.bodyRows
  const isPinned = Boolean(usageLine) && e.props.placement !== 'inline'

  return (
    <Box flexDirection="column" minHeight={isPinned ? bodyRows : undefined}>
      <Box key="body" flexDirection="column" paddingX={1} flexGrow={1}>
        {mainLines}
        {bgLines}
        <Text key="gap" dimColor>{' '}</Text>
        {rule('agents-title', 'AGENTS', list.length ? summary : undefined)}
        {list.length ? liveBlocks : <Text key="none" dimColor>none yet this session</Text>}
        {doneBlocks.length > 0 && <Text key="finished" dimColor>{'finished'}</Text>}
        {doneBlocks}
        <Box key="foot" flexDirection="row" marginTop={1} gap={1}>
          {done + failed + stopped + bgDone.length > 0 && <Button key="clear" hotkey="c" onPress={() => void Promise.all([setRows($, held => held.filter(isLive)), update($, bg, held => held.filter(isBgLive))])}>Clear finished</Button>}
          {viewing && <Button key="back" hotkey="m" onPress={() => void $.ui.view({})}>Back to main</Button>}
          {list.length > 0 && <Text dimColor>click an agent for details</Text>}
        </Box>
        {!isPinned && usageLine}
      </Box>
      {isPinned && <Box key="usage-room" height={1} />}
      {isPinned && <Box key="usage-bar" position="absolute" top={e.props.scroll.offset + bodyRows - 1} left={1} right={1}>{usageLine}</Box>}
    </Box>
  )
}
