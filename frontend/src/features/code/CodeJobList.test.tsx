import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeFilters } from './api'
import { codeJob } from './testJobs'
import type { CodeJob } from './threads'

type ListState = { isPending?: boolean; isError?: boolean; error?: Error; jobs?: CodeJob[]; projects?: string[] }
let state: ListState = {}
const asked: CodeFilters[] = []
const refetch = vi.fn()
vi.mock('./api', () => ({
  useCodeJobs: (filters: CodeFilters) => {
    asked.push(filters)
    return {
      isPending: Boolean(state.isPending), isError: Boolean(state.isError), error: state.error, refetch,
      data: state.jobs ? { pages: [{ jobs: state.jobs, projects: state.projects ?? [], has_more: false }] } : undefined,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
    }
  },
}))

const { CodeJobList } = await import('./CodeJobList')

// Radix Select scrolls to the chosen option, which jsdom can't do.
Element.prototype.scrollIntoView ??= () => {}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function show(url = '/code', jobId?: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="*" element={<><CodeJobList jobId={jobId} /><Where /></>} /></Routes>
    </MemoryRouter>,
  )
}

const JOBS = [
  codeJob({ id: 'a1', title: 'Bump the version', project: 'anemo', started_at: '2026-11-23T08:00:00Z', num_turns: 10, cost_usd: 1.25, branch: 'feat/version' }),
  codeJob({ id: 'a2', thread_id: 'a1', title: 'Also the changelog', project: 'anemo', started_at: '2026-11-23T09:00:00Z', num_turns: 2, cost_usd: 0.25, state: 'running', pr_url: 'https://github.com/essntl/anemo/pull/68' }),
  codeJob({ id: 's1', title: 'Fix the footer', project: 'site', started_at: '2026-11-23T07:00:00Z', state: 'failed', device: { id: 'd2', name: 'Laptop', online: false, last_seen_at: null, share: false, start: false, cancel: false } }),
  codeJob({ id: 'a3', title: 'Old cleanup', project: 'anemo', started_at: '2026-11-20T07:00:00Z' }),
]

describe('the Code list', () => {
  beforeEach(() => {
    state = {}
    asked.length = 0
    vi.clearAllMocks()
  })

  it('groups threads by project, newest first, one row per thread', () => {
    state = { jobs: JOBS, projects: ['anemo', 'site'] }
    show('/code', 'a1')
    const sections = screen.getAllByRole('region')
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['anemo', 'site'])
    const rows = within(sections[0]).getAllByTestId('code-thread')
    expect(rows).toHaveLength(2)
    // The thread shows its first job's title and its latest job.
    expect(rows[0]).toHaveTextContent('Bump the version')
    expect(rows[0]).not.toHaveTextContent('Also the changelog')
    expect(rows[0]).toHaveTextContent('Running')
    expect(rows[0]).toHaveTextContent('1 follow-up')
    expect(rows[0]).toHaveTextContent('12 turns')
    expect(rows[0]).toHaveTextContent('$1.50 API-equivalent')
    expect(rows[0]).toHaveTextContent('#68')
    expect(rows[0]).toHaveAttribute('href', '/code/a2')
    // The open job's thread is marked.
    expect(rows[0]).toHaveAttribute('aria-current', 'page')
    expect(rows[1]).toHaveTextContent('Old cleanup')
    const site = within(sections[1]).getByTestId('code-thread')
    expect(site).toHaveTextContent('Failed')
    expect(site).toHaveTextContent('Laptop · offline')
  })

  it('reads the filters from the address and keeps them in the links', () => {
    state = { jobs: [JOBS[2]], projects: ['anemo', 'site'] }
    show('/code?project=site&state=failed')
    expect(asked.at(-1)).toEqual({ project: 'site', state: 'failed' })
    expect(screen.getByTestId('code-thread')).toHaveAttribute('href', '/code/s1?project=site&state=failed')
  })

  it('ignores a state it does not know', () => {
    state = { jobs: [] }
    show('/code?state=exploded')
    expect(asked.at(-1)).toEqual({ project: null, state: null })
  })

  it('puts a chosen filter into the address', async () => {
    state = { jobs: JOBS, projects: ['anemo', 'site'] }
    show('/code')
    screen.getByRole('combobox', { name: 'State' }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('option', { name: 'Exited without result' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/code?state=exited_without_result')
    expect(asked.at(-1)).toEqual({ project: null, state: 'exited_without_result' })
  })

  it('shows skeleton rows while loading', () => {
    state = { isPending: true }
    show()
    expect(screen.getByLabelText('Loading…')).toHaveAttribute('aria-busy', 'true')
  })

  it('says how to start sharing when there are no jobs', () => {
    state = { jobs: [] }
    show()
    expect(screen.getByText('No Claude Code jobs yet')).toBeInTheDocument()
    expect(screen.getByText(/Share Claude Code jobs with Anemo/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Devices' })).toHaveAttribute('href', '/settings/devices')
  })

  it('offers to clear the filters when none match', async () => {
    state = { jobs: [] }
    show('/code?project=site')
    expect(screen.getByText('No jobs match these filters')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/code$/)
  })

  it('shows an error with a way to try again', async () => {
    state = { isError: true, error: new Error('The server is down') }
    show()
    expect(screen.getByText('The server is down')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
  })
})
