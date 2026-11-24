import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { useIslandVisible } from '@/features/island/islandStore'
import sample from './agents.fixture.json'
import { codeKey } from './api'
import { CodeThreadView } from './CodeThreadView'
import { codeJob } from './testJobs'
import type { CodeJob } from './threads'
import type { CodeEvent } from './timeline'

/** A stand-in for the browser's EventSource: the test sends the frames. */
class FakeEventSource {
  static all: FakeEventSource[] = []
  url: string
  closed = false
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>()
  constructor(url: string) {
    this.url = url
    FakeEventSource.all.push(this)
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data ?? {}) }))
  }
}

const event = (seq: number, e: Record<string, unknown>, more: Partial<CodeEvent> = {}): CodeEvent => ({
  seq, kind: 'assistant', event: e, trimmed: false, dropped: false, created_at: '2026-11-23T10:15:00Z', ...more,
})
const text = (seq: number, value: string, more: Partial<CodeEvent> = {}) =>
  event(seq, { type: 'assistant', message: { content: [{ type: 'text', text: value }] }, parent_tool_use_id: null }, more)

// `desktop`: the `md` width and up (jsdom has no matchMedia). Nothing here is a touch screen.
// `wide`: the `xl` width, where the sub-agents get a column of their own.
const media = vi.hoisted(() => ({ desktop: true, wide: false }))
vi.mock('@/hooks/useMediaQuery', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useMediaQuery')>()
  return {
    ...real,
    useMediaQuery: (query: string) => (query === real.DESKTOP && media.desktop) || (query === '(min-width: 1280px)' && media.wide),
  }
})

let thread: CodeJob[] = []
let events: Record<string, CodeEvent[]> = {}
const eventCalls: { job: string; after: number }[] = []

beforeEach(() => {
  FakeEventSource.all = []
  eventCalls.length = 0
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.spyOn(api, 'GET').mockImplementation((async (path: string, init: { params: { path: { job_id: string }; query?: { after_seq?: number } } }) => {
    const id = init.params.path.job_id
    const response = { ok: true, status: 200 } as Response
    if (path === '/api/code/jobs/{job_id}') return { data: { job: thread.find((j) => j.id === id) ?? thread[0], thread }, response }
    const after = init.params.query?.after_seq ?? 0
    eventCalls.push({ job: id, after })
    const list = (events[id] ?? []).filter((e) => e.seq > after)
    return { data: { events: list, last_seq: list.at(-1)?.seq ?? after, has_more: false }, response }
  }) as unknown as typeof api.GET)
})
afterEach(() => {
  media.desktop = true
  media.wide = false
  useIslandVisible.setState({ visible: false })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The address's query, to check what a click put there. */
function Search() {
  return <output data-testid="search">{useLocation().search}</output>
}

function show(jobId: string, search = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/code/${jobId}${search}`]}><CodeThreadView jobId={jobId} backTo="/code" /><Search /></MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

describe('a finished thread', () => {
  beforeEach(() => {
    thread = [
      codeJob({
        id: 'j1', title: 'Bump the version', prompt: 'Bump the version to 1.1.0', state: 'done', session_id: 'sess-1',
        started_at: '2026-11-23T09:00:00Z', ended_at: '2026-11-23T09:05:00Z', num_turns: 12, cost_usd: 1.5, duration_ms: 300_000,
        result_text: 'Bumped to **1.1.0**.', result_subtype: 'success', job_dir: 'C:\\anemo-bridge\\jobs\\20261123-090000-ab12', truncated: true,
      }),
      codeJob({
        id: 'j2', thread_id: 'j1', title: 'Also the changelog', prompt: 'Now add it to the changelog', state: 'failed', resume_session: 'sess-1', session_id: 'sess-2',
        started_at: '2026-11-23T10:00:00Z', ended_at: '2026-11-23T10:01:00Z', num_turns: 3, cost_usd: 0.25, result_subtype: 'error_max_turns', is_error: true,
        branch: 'feat/version', pr_url: 'https://github.com/essntl/anemo/pull/68',
        device: { id: 'dev-1', name: 'Desk PC', online: false, last_seen_at: '2026-11-23T10:02:00Z', share: false, start: false, cancel: false },
        todos: [{ content: 'Bump', status: 'completed' }, { content: 'Changelog', status: 'pending', activeForm: 'Writing the changelog' }],
      }),
    ]
    events = {
      j1: [text(1, 'Looking at **package.json**', { trimmed: true }), event(2, { type: 'result', subtype: 'success', result: 'Bumped to **1.1.0**.' }, { kind: 'result' })],
      j2: [text(1, 'On it'), event(2, { type: 'assistant' }, { dropped: true }), event(3, { type: 'user' }, { dropped: true, kind: 'user' })],
    }
  })

  it('shows the header, each job with its prompt, separators and result cards', async () => {
    show('j2')
    expect(await screen.findByRole('heading', { name: 'Bump the version' })).toBeInTheDocument()
    expect(screen.getByText('feat/version')).toHaveAttribute('href', 'https://github.com/essntl/anemo/tree/feat/version')
    expect(screen.getByRole('link', { name: 'Pull request #68' })).toHaveAttribute('href', 'https://github.com/essntl/anemo/pull/68')
    expect(screen.getByTestId('device-offline')).toHaveTextContent(/^offline since /)
    expect(screen.getByText('sess-2')).toBeInTheDocument()
    // The thread's API-equivalent cost and turns, over both jobs.
    expect(screen.getAllByText('API-equivalent cost')[0].parentElement).toHaveTextContent('$1.75')

    const parts = screen.getAllByTestId('code-job')
    expect(parts).toHaveLength(2)
    expect(within(parts[0]).getByText('Bump the version to 1.1.0')).toBeInTheDocument()
    expect(await within(parts[0]).findByText('package.json')).toBeInTheDocument()
    expect(within(parts[1]).getByRole('separator')).toHaveTextContent(/^Follow-up · started /)
    expect(within(parts[1]).getByText('Now add it to the changelog')).toBeInTheDocument()

    const first = within(parts[0]).getByRole('region', { name: 'Result' })
    expect(first).toHaveTextContent('Finished')
    expect(within(first).getByText('1.1.0').tagName).toBe('STRONG')
    expect(first).toHaveTextContent('12')
    expect(first).toHaveTextContent('5 min')
    expect(first).toHaveTextContent('$1.50')
    const second = within(parts[1]).getByRole('region', { name: 'Result' })
    expect(second).toHaveTextContent('Failed: error_max_turns')
    // A finished job opens no stream.
    expect(FakeEventSource.all).toHaveLength(0)
  })

  it('keeps the way back, the state and the title in one row', async () => {
    media.desktop = false // a phone
    show('j2')
    const row = (await screen.findByRole('link', { name: 'All jobs' })).parentElement!
    expect(await within(row).findByText('Failed')).toBeInTheDocument()
    expect(within(row).getByText('Bump the version')).toBeInTheDocument()
  })

  it('on a phone, moves the state and the title under the Dynamic Island while it shows', async () => {
    media.desktop = false
    useIslandVisible.setState({ visible: true })
    show('j2')
    const row = (await screen.findByRole('link', { name: 'All jobs' })).parentElement!
    const bar = row.parentElement!
    expect(await within(bar).findByText('Failed')).toBeInTheDocument()
    expect(within(bar).getByText('Bump the version')).toBeInTheDocument()
    // The row the Island floats over keeps only the way back.
    expect(within(row).queryByText('Bump the version')).not.toBeInTheDocument()
    // With room beside the Island (a wider screen) it is one row again.
    act(() => { media.desktop = true; useIslandVisible.setState({ visible: false }) })
    expect(within(row).getByText('Bump the version')).toBeInTheDocument()
  })

  it('says where the full log is for trimmed and dropped events', async () => {
    show('j1')
    const parts = await screen.findAllByTestId('code-job')
    await userEvent.click(await within(parts[0]).findByRole('button', { name: 'trimmed' }))
    expect(within(parts[0]).getByText('Shortened to be stored. The full log is on the computer: C:\\anemo-bridge\\jobs\\20261123-090000-ab12\\out.jsonl')).toBeInTheDocument()
    expect(await within(parts[1]).findByText('2 events not stored (over 5 MB).')).toBeInTheDocument()
  })

  it('folds the todo list once the job has ended', async () => {
    show('j2')
    const toggle = await screen.findByRole('button', { name: /Todo list/ })
    expect(toggle).toHaveTextContent('1 / 2')
    expect(screen.queryByText('Changelog')).not.toBeInTheDocument()
    await userEvent.click(toggle)
    // Not running any more: the item, not what it was doing.
    expect(screen.getByText('Changelog')).toBeInTheDocument()
  })

  it('fetches the rest of a finished job when its last_seq grows after a notice', async () => {
    // Back-filled: announced finished first, its events arrive afterwards.
    thread = [codeJob({ id: 'b', state: 'done', last_seq: 1, result_text: 'All done.' })]
    events = { b: [text(1, 'one')] }
    const client = show('b')
    expect(await screen.findByText('one')).toBeInTheDocument()
    expect(FakeEventSource.all).toHaveLength(0)
    events.b.push(text(2, 'two'), text(3, 'three'))
    thread = [{ ...thread[0], last_seq: 3 }]
    // The app-wide code.job notice.
    await act(async () => client.invalidateQueries({ queryKey: codeKey }))
    expect(await screen.findByText('three')).toBeInTheDocument()
    expect(eventCalls.filter((c) => c.job === 'b')).toEqual([{ job: 'b', after: 0 }, { job: 'b', after: 1 }])
    // Another notice with nothing new fetches nothing.
    await act(async () => client.invalidateQueries({ queryKey: codeKey }))
    await waitFor(() => expect(eventCalls.filter((c) => c.job === 'b')).toHaveLength(2))
  })

  it('shows the end of stderr when the job exited without a result', async () => {
    thread = [codeJob({ id: 'x', state: 'exited_without_result', stderr_tail: 'Error: Invalid API key' })]
    events = { x: [] }
    show('x')
    const card = await screen.findByRole('region', { name: 'Result' })
    expect(card).toHaveTextContent('Exited without a result')
    expect(card).toHaveTextContent('Error: Invalid API key')
  })
})

describe('a running job', () => {
  beforeEach(() => {
    thread = [codeJob({
      id: 'r1', title: 'Fix the footer', state: 'running', started_at: new Date(Date.now() - 65_000).toISOString(),
      todos: [
        { content: 'Find the footer', status: 'completed', activeForm: 'Finding the footer' },
        { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' },
        { content: 'Open a PR', status: 'pending' },
      ],
    })]
    events = { r1: [text(1, 'first'), text(2, 'second')] }
  })

  it('pins the todo list, with what it is doing now', async () => {
    show('r1')
    const toggle = await screen.findByRole('button', { name: /Todo list/ })
    expect(toggle).toHaveTextContent('1 / 3')
    expect(toggle.parentElement).toHaveClass('sticky')
    expect(screen.getByText('Fixing it')).toBeInTheDocument()
    expect(screen.getByText('Open a PR')).toBeInTheDocument()
  })

  it('merges live events by seq, fetches what a gap missed, and stops at the end', async () => {
    show('r1')
    expect(await screen.findByText('second')).toBeInTheDocument()
    const source = FakeEventSource.all[0]
    expect(source.url).toBe('/api/code/jobs/r1/stream')

    // Opened: what came before the stream is fetched after the last seq we have.
    await act(async () => source.emit('open'))
    await waitFor(() => expect(eventCalls.at(-1)).toEqual({ job: 'r1', after: 2 }))

    // A frame that follows on, and one repeated: each event once.
    await act(async () => source.emit('code.events', { job_id: 'r1', events: [text(3, 'third'), text(2, 'second')] }))
    expect(await screen.findByText('third')).toBeInTheDocument()
    expect(screen.getAllByText('second')).toHaveLength(1)

    // A frame after a gap (4 and 5 were lost): they are fetched.
    events.r1.push(text(4, 'fourth'), text(5, 'fifth'))
    await act(async () => source.emit('code.events', { job_id: 'r1', events: [text(6, 'sixth')] }))
    expect(await screen.findByText('fifth')).toBeInTheDocument()
    expect(eventCalls.at(-1)).toEqual({ job: 'r1', after: 3 })
    const texts = screen.getAllByText(/^(first|second|third|fourth|fifth|sixth)$/).map((el) => el.textContent)
    expect(texts).toEqual(['first', 'second', 'third', 'fourth', 'fifth', 'sixth'])

    // The job ended: its result shows and the stream closes.
    await act(async () => source.emit('code.job', { job: { ...thread[0], state: 'done', result_text: 'Footer fixed.', num_turns: 6 } }))
    expect(await screen.findByRole('region', { name: 'Result' })).toHaveTextContent('Footer fixed.')
    await waitFor(() => expect(source.closed).toBe(true))
    expect(screen.queryByRole('button', { name: /Todo list/ })?.parentElement).not.toHaveClass('sticky')
  })

  it('fetches the rest when a code.job frame says there is more, without any code.events', async () => {
    show('r1')
    await screen.findByText('second')
    const source = FakeEventSource.all[0]
    // The server's stream sends only snapshots (Valkey is down): no code.events at all.
    events.r1.push(text(3, 'third'), text(4, 'fourth'))
    const calls = eventCalls.length
    await act(async () => source.emit('code.job', { job: { ...thread[0], last_seq: 4 } }))
    expect(await screen.findByText('fourth')).toBeInTheDocument()
    expect(eventCalls.slice(calls)).toEqual([{ job: 'r1', after: 2 }])
    // The same snapshot again: nothing is missing, nothing is fetched.
    await act(async () => source.emit('code.job', { job: { ...thread[0], last_seq: 4 } }))
    expect(eventCalls).toHaveLength(calls + 1)
  })

  it('ignores frames it cannot read', async () => {
    show('r1')
    await screen.findByText('second')
    const source = FakeEventSource.all[0]
    await act(async () => {
      for (const fn of (source as unknown as { listeners: Map<string, ((e: MessageEvent<string>) => void)[]> }).listeners.get('code.events') ?? []) {
        fn(new MessageEvent('code.events', { data: 'not json' }))
      }
      source.emit('code.job', { job: null })
    })
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(source.closed).toBe(false)
  })
})

describe('a job with sub-agents', () => {
  const SETUP = 'toolu_01VsoTZBKwaqBXxfEzXgZkAr'
  const VOICE = 'toolu_012dPMLFLMR8cG5UVa2zzbb4'
  const SAMPLE = sample as unknown as CodeEvent[]
  beforeEach(() => {
    thread = [codeJob({ id: 'o1', title: 'Orchestrate round 3', prompt: 'You are the ORCHESTRATOR', state: 'done', last_seq: SAMPLE.length })]
    events = { o1: SAMPLE }
  })

  it('lists Main and each sub-agent beside the thread, and shows only the picked agent\'s events', async () => {
    media.wide = true
    show('o1')
    const list = await screen.findByRole('list', { name: 'Agents' })
    expect(await within(list).findByText('B: Android voice mode')).toBeInTheDocument()
    expect(within(list).getByText('Main agent')).toBeInTheDocument()
    expect(within(list).getByText('Set up local test toolchain').closest('button')).toHaveTextContent('27 tool calls')
    // The job has ended without their end: neither runs on.
    expect(within(list).getAllByRole('img', { name: 'Stopped' })).toHaveLength(2)
    // Main: the orchestrator's text and its Agent calls, none of the sub-agents' work.
    expect(screen.getByText(/start by reading the required docs/)).toBeInTheDocument()
    expect(screen.queryByText(/voice-mode-android && git status/)).not.toBeInTheDocument()

    await userEvent.click(within(list).getByText('B: Android voice mode'))
    expect(screen.getByTestId('search')).toHaveTextContent(`?agent=${VOICE}`)
    const view = await screen.findByTestId('code-agent')
    expect(within(view).getByText(/voice-mode-android && git status/)).toBeInTheDocument()
    expect(screen.queryByText(/start by reading the required docs/)).not.toBeInTheDocument()
    expect(screen.queryByText(/ci\.yml/)).not.toBeInTheDocument()
    // Back to the main agent.
    await userEvent.click(within(view).getByRole('button', { name: 'Main agent' }))
    expect(screen.getByTestId('search')).toBeEmptyDOMElement()
    expect(await screen.findByText(/start by reading the required docs/)).toBeInTheDocument()
  })

  it('opens on the sub-agent in the address (a reload keeps it)', async () => {
    media.wide = true
    show('o1', `?agent=${SETUP}`)
    const view = await screen.findByTestId('code-agent')
    expect(within(view).getByText('Set up local test toolchain')).toBeInTheDocument()
    expect(within(view).getByText(/ci\.yml/)).toBeInTheDocument()
    // Its prompt, from the Agent call, as the message it was given.
    expect(within(view).getByText(/You prepare a local test toolchain/)).toBeInTheDocument()
  })

  it('links an Agent call of the main timeline to its sub-agent', async () => {
    show('o1')
    const row = await screen.findByRole('button', { name: /Agent\s*B: Android voice mode/ })
    await userEvent.click(row)
    await userEvent.click(screen.getByRole('button', { name: /Open this sub-agent/ }))
    expect(screen.getByTestId('search')).toHaveTextContent(`?agent=${VOICE}`)
  })

  it('on narrower screens, switches agents from the top bar', async () => {
    media.desktop = false // a phone: the list is a sheet
    show('o1')
    const switcher = await screen.findByRole('button', { name: 'Agent: Main agent' })
    expect(screen.queryByRole('list', { name: 'Agents' })).not.toBeInTheDocument()
    await userEvent.click(switcher)
    const sheet = await screen.findByRole('dialog')
    await userEvent.click(within(sheet).getByText('Set up local test toolchain'))
    expect(screen.getByTestId('search')).toHaveTextContent(`?agent=${SETUP}`)
    expect(await screen.findByRole('button', { name: 'Agent: Set up local test toolchain' })).toBeInTheDocument()
  })

  it('shows a running sub-agent as running, and its end as it comes', async () => {
    media.wide = true
    thread = [codeJob({ id: 'o1', title: 'Orchestrate round 3', state: 'running', last_seq: SAMPLE.length })]
    show('o1')
    const list = await screen.findByRole('list', { name: 'Agents' })
    expect(await within(list).findAllByRole('img', { name: 'Running' })).toHaveLength(2)
    expect(within(list).getByText('2 sub-agents running')).toBeInTheDocument()
    // A new event on the job's stream: the first agent ends.
    await waitFor(() => expect(FakeEventSource.all.length).toBeGreaterThan(0))
    act(() => FakeEventSource.all[0].emit('code.events', {
      events: [{
        seq: SAMPLE.length + 1, kind: 'system', trimmed: false, dropped: false, created_at: '2026-11-24T12:00:00Z',
        event: { type: 'system', subtype: 'task_notification', tool_use_id: SETUP, status: 'completed' },
      }],
    }))
    expect(await within(list).findByRole('img', { name: 'Done' })).toBeInTheDocument()
    expect(within(list).getByText('1 sub-agent running')).toBeInTheDocument()
  })

  it('shows no agents for a job without sub-agents', async () => {
    media.wide = true
    events = { o1: [text(1, 'Just me')] }
    thread = [codeJob({ id: 'o1', state: 'done', last_seq: 1 })]
    show('o1')
    expect(await screen.findByText('Just me')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Agent:/ })).not.toBeInTheDocument()
  })
})
