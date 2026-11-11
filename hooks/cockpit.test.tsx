import { expect, mock, test } from 'claude-code/testing'

const SEC = 1000
const MIN = 60 * SEC
const BAND = { plugin: 'cockpit', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = { plugin: 'cockpit', component: 'Pane', requestId: 'cockpit', props: { title: 'Cockpit', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const
const USAGE = { startedAt: 0, context: { tokens: 323000, window: 1000000, percent: 32 }, rateLimits: [], cost: { usd: 1 } }

async function setup($: any, on: any, opts: { paneShown?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const toasts: string[] = []
  const stops: string[] = []
  const views: unknown[] = []
  const opens: unknown[] = []
  let list: any[] | undefined
  const started: any[] = []
  let n = 0
  let release = () => {}
  let chunks: any[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: list ?? started }))
  on('agent.spawn', (_: any, e: any) => {
    const agentId = `a${++n}`
    started.push({ id: agentId, type: e.subagentType, description: e.description, status: 'running' })
    return { agentId, model: 'claude-sonnet-5-5' }
  })
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.open', (_: any, e: any) => { opens.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opts.paneShown ? [{ id: 'cockpit', title: 'Cockpit', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.view', (_: any, e: any) => { views.push(e); return { value: {} } })
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'halfway there', toolUses: [] }] }))
  on('tool.call', async (_: any, e: any) => {
    if (e.tool === 'TaskStop') stops.push(e.task_id)
    if (e.command === 'hold') await new Promise<void>(r => { release = r })
    if (e.command === 'fail') return { result: {}, text: 'boom', isError: true }
    return { result: {}, text: 'ok' }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: any, e: any) {
    for (const c of chunks) yield c
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 } }
  })
  on('turn.complete', (_: any, e: any) => ({ text: e.answer ?? '' }))
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const spawn = (description: string, background = true) =>
    $.agent.spawn({ prompt: 'x', description, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background, fork: false })
  const step = async (agentId?: string) => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: agentId ? 'claude-sonnet-5-5' : 'claude-opus-5-5', effort: agentId ? 'medium' : 'high', messageCount: 3, ...(agentId ? { agentId } : {}) })) {}
  }
  return {
    clock, toasts, stops, views, opens, spawn, step,
    setList: (l: any[]) => { list = l },
    setChunks: (c: any[]) => { chunks = c },
    release: () => release(),
  }
}

test('opens the sidebar by itself only where the screen docks it, once', async ($, on) => {
  const { opens } = await setup($, on)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal', viewport: { columns: 200, rows: 50, isFullscreen: false } } as any)
  await ui.unmount()
  expect(opens).toEqual([])
  ui = await $.ui.mount({ ...BAND, surface: 'terminal', viewport: { columns: 200, rows: 50, isFullscreen: true } } as any)
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal', viewport: { columns: 200, rows: 50, isFullscreen: true } } as any)
  await ui.unmount()
  expect(opens).toEqual([{ id: 'cockpit', title: 'Cockpit', columns: 64 }])
})

test('the all-finished toast counts only the batch that just finished', async ($, on) => {
  const { toasts, spawn } = await setup($, on)
  await spawn('one')
  await spawn('two')
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'x', durationMs: 1, isAborted: false } as any)
  await $.turn.complete({ agentId: 'a2', reason: 'answer', answer: 'x', durationMs: 1, isAborted: false } as any)
  expect(toasts.at(-1)).toContain('all 2 agents finished')
  await spawn('three')
  await spawn('four')
  await $.turn.complete({ agentId: 'a3', reason: 'answer', answer: 'x', durationMs: 1, isAborted: false } as any)
  await $.turn.complete({ agentId: 'a4', reason: 'answer', answer: 'x', durationMs: 1, isAborted: false } as any)
  expect(toasts.at(-1)).toContain('all 2 agents finished')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`MAIN shows state, model, ctx, cache, the open tool and finished steps (${surface})`, async ($, on) => {
    const { clock, step, release } = await setup($, on, { paneShown: true })
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await step()
    await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' })
    await $.tool.call({ tool: 'Bash', command: 'fail', description: 'Run tests' })
    const held = $.tool.call({ tool: 'Bash', command: 'hold', description: 'Build the bundle' })
    await clock.advance(101 * SEC)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /working/ }))?.text).toContain('● working 1m41s')
    expect((await ui.find({ type: 'Text', text: /^model/ }))?.text).toContain('opus 5.5 · high · request 1 · 3 tools')
    expect((await ui.find({ type: 'Text', text: /^errors/ }))?.text).toContain('1 failed this turn')
    expect((await ui.find({ type: 'Text', text: /^ctx/ }))?.text).toContain('████░░░░░░░░  32%  323k/1.0M')
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toContain('warm, ~59m left')
    expect((await ui.find({ type: 'Text', text: /^now/ }))?.text).toContain('1m41s  Build the bundle')
    expect((await ui.find({ type: 'Text', text: /✗ Run tests/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /✓ Read a.ts/ }))).toBeTruthy()
    release()
    await held
    await ui.unmount()
  })
}

test('MAIN says what the model is streaming when no tool runs', async ($, on) => {
  const { step, setChunks } = await setup($, on, { paneShown: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  setChunks([{ kind: 'thinking', index: 0, text: 'hm' }, { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' }])
  await step()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^now/ }))?.text).toContain('preparing Bash call')
  await ui.unmount()
})

test('AGENTS: running agent block with meta and current tool; stalled flag', async ($, on) => {
  const { clock, spawn, step, release } = await setup($, on, { paneShown: true })
  await spawn('scan the repo')
  await step('a1')
  const held = $.tool.call({ tool: 'Bash', command: 'hold', description: 'Run the test suite', agentId: 'a1' } as any)
  await clock.advance(4 * SEC)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /1 running/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /sonnet 5.5 medium · Explore/ }))?.text).toContain('tools · ctx 42k')
  expect((await ui.find({ type: 'Text', text: /↳/ }))?.text).toContain('4s  Run the test suite')
  await ui.unmount()
  release()
  await held
  await clock.advance(3 * MIN + 5 * SEC)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /↳/ }))?.text).toContain('quiet 3m')
  await ui.unmount()
})

test('AGENTS: open a row, view its transcript, stop it', async ($, on) => {
  const { spawn, step, stops, views } = await setup($, on, { paneShown: true })
  await spawn('deep dive')
  await step('a1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'row:a1' })
  expect((await ui.find({ type: 'Text', text: /halfway there/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /effort medium/ }))?.text).toContain('ctx 42k')
  await ui.press({ key: 'view:a1' })
  expect(views).toEqual([{ agentId: 'a1' }])
  await ui.press({ key: 'stop:a1' })
  expect(stops).toEqual(['a1'])
  await ui.unmount()
})

test('finishing toasts; all-done toast; a TaskStop the hooks never saw is picked up', async ($, on) => {
  const { clock, toasts, spawn, step, setList } = await setup($, on)
  await spawn('one')
  await spawn('two')
  await spawn('three')
  await step('a1')
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'found it', durationMs: 1000, isAborted: false } as any)
  expect(toasts.at(-1)).toContain('one done')
  await $.turn.complete({ agentId: 'a2', reason: 'error', answer: '', durationMs: 1000, isAborted: false } as any)
  expect(toasts).toContain('✗ Explore failed: two')
  setList([{ id: 'a3', type: 'Explore', description: 'three', status: 'killed' }])
  await clock.advance(3 * SEC)
  expect(toasts.at(-1)).toContain('all 3 agents finished')
})

test('summary line above the prompt only while the sidebar is hidden', async ($, on) => {
  const { clock, spawn, step } = await setup($, on)
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await step()
  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' })
  await spawn('worker')
  await step('a1')
  await clock.advance(3 * MIN + 5 * SEC)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await ui.find({ type: 'Text', text: /main/ }))?.text ?? ''
  expect(line).toContain('● main 3m05s · agents 1 running · 1 stalled  │  thinking')
  await ui.unmount()
})

test('no summary line while the sidebar shows', async ($, on) => {
  const { step } = await setup($, on, { paneShown: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await step()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /main/ })).toBeFalsy()
  await ui.unmount()
})

test('main-thread tool calls are not counted against an agent', async ($, on) => {
  const { spawn } = await setup($, on, { paneShown: true })
  await spawn('worker')
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /· Explore/ }))?.text).toContain('0 tools')
  await ui.unmount()
})

test('an agent the engine no longer lists is marked stopped, not left running', async ($, on) => {
  const { clock, spawn, setList } = await setup($, on, { paneShown: true })
  await spawn('ghost')
  await clock.advance(20 * SEC)
  setList([])
  await clock.advance(4 * SEC)
  let early = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await early.find({ type: 'Text', text: /AGENTS/ }))?.text).toContain('1 running')
  await early.unmount()
  await clock.advance(10 * SEC)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /AGENTS/ }))?.text).toContain('0 running · 0 done · 1 stopped')
  await ui.unmount()
})

test('finished agents sit under a finished heading; stopped is not failed', async ($, on) => {
  const { spawn } = await setup($, on, { paneShown: true })
  await spawn('alive')
  await spawn('cancelled')
  await $.turn.complete({ agentId: 'a2', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /AGENTS/ }))?.text).toContain('1 running · 0 done · 1 stopped')
  expect(await ui.find({ type: 'Text', text: /^finished$/ })).toBeTruthy()
  await ui.unmount()
})

test('a completion that lands during a sync is not overwritten by the sync', async ($, on) => {
  const { clock, spawn, toasts } = await setup($, on, { paneShown: true })
  await spawn('racer')
  await spawn('other')
  await clock.advance(1 * SEC)
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as any)
  await clock.advance(3 * SEC)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /AGENTS/ }))?.text).toContain('1 running · 1 done')
  expect(toasts.some(t => t.includes('racer done'))).toBe(true)
  await ui.unmount()
})
