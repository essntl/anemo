import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '@/api/client'
import { answer, mockApi, renderWithProviders, stubMatchMedia } from '@/test/pluginFixtures'
import { codeJobKey } from '../api'
import { noticeCodeJob } from '../codeJobNotices'
import { codeJob } from '../testJobs'
import { useGitViewStore } from './gitRepoStore'
import { GitView } from './GitView'

/* The Code page's Git view: picking a repository, the graph and its states, refreshing,
 * more commits, a commit's details, the branches, and reading again on a job's notice. */

const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toasts.push(o.message) }))
// Radix Select scrolls to the chosen option, and the list to the selected row: jsdom can't.
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.scrollTo ??= () => {}

type Graph = Schemas['GitGraph']
type Detail = Schemas['GitCommitDetail']

const DEV = 'dev-1'
const device = { id: DEV, name: 'Desk PC', online: true, last_seen_at: null, share: true, start: true, cancel: true }
const h = (name: string) => name.padEnd(40, '0')

const commit = (name: string, parents: string[], refs: string[] = [], subject = `Commit ${name}`): Graph['commits'][number] => ({
  hash: h(name), parents: parents.map(h), authorName: 'Artem Kotov', authorEmail: 'artem@example.com',
  date: '2026-11-20T10:00:00Z', subject, refs,
})
const pr = { number: 90, title: 'The Git view', headRef: 'feature', url: 'https://github.com/o/anemo/pull/90', draft: false }

function graph(over: Partial<Graph> = {}): Graph {
  return {
    head: { branch: 'main', commit: h('c3'), detached: false },
    branches: [
      { name: 'main', commit: h('c3'), remote: false, upstream: 'origin/main', ahead: 0, behind: 2, current: true, pullRequest: null },
      { name: 'feature', commit: h('f1'), remote: false, upstream: 'origin/feature', ahead: 1, behind: 0, current: false, pullRequest: null },
      { name: 'origin/main', commit: h('c3'), remote: true, upstream: null, ahead: 0, behind: 0, current: false, pullRequest: null },
      { name: 'origin/feature', commit: h('c1'), remote: true, upstream: null, ahead: 0, behind: 0, current: false, pullRequest: pr },
    ],
    tags: [{ name: 'v1.0', commit: h('c1') }],
    commits: [
      commit('c3', ['c2', 'f1'], ['HEAD', 'main', 'origin/main'], 'Merge feature'),
      commit('f1', ['c1'], ['feature'], 'Feature work'),
      commit('c2', ['c1'], [], 'Second'),
      commit('c1', [], ['origin/feature', 'tag: v1.0'], 'First'),
    ],
    status: { dirty: true, staged: 2, unstaged: 3, untracked: 1, conflicted: 0 },
    remotes: [{ name: 'origin', url: 'https://github.com/o/anemo.git' }],
    truncated: false, source: 'local', repo: null,
    fetchedAt: new Date(Date.now() - 3 * 60_000).toISOString(), fetchError: null, pullRequests: [pr],
    ...over,
  }
}

const detail = (name: string, over: Partial<Detail> = {}): Detail => ({
  hash: h(name), parents: [h('c2'), h('f1')], authorName: 'Artem Kotov', authorEmail: 'artem@example.com',
  date: '2026-11-20T10:00:00Z', committerDate: '2026-11-20T10:00:00Z', committerName: 'GitHub', subject: 'Merge feature', body: 'Line one\n<b>not html</b>',
  files: [
    { path: 'src/app.ts', status: 'M', additions: 12, deletions: 4 },
    { path: 'logo.png', status: 'A', additions: null, deletions: null },
  ],
  stats: { files: 2, additions: 12, deletions: 4 }, truncated: false, ...over,
})

const projects = {
  projects: [{ name: 'anemo', dir: 'C:\\dev\\anemo', remote: 'https://github.com/o/anemo.git', repo: 'o/anemo' }],
  remote: [
    { name: 'site', url: 'https://github.com/o/site', repo: 'o/site' },
    { name: 'no-owner', url: 'https://example.com/x', repo: null },
  ],
  note: null,
}

let graphs: Record<string, unknown>[] = []
let commits: Record<string, unknown>[] = []
let answerGraph: (body: Record<string, unknown>) => unknown = () => graph()

function setup(routes: Record<string, (r: { body: unknown }) => unknown> = {}) {
  return mockApi({
    'GET /api/code/devices': () => [device],
    [`GET /api/code/devices/${DEV}/projects`]: () => projects,
    [`POST /api/code/devices/${DEV}/git/graph`]: ({ body }) => {
      graphs.push(body as Record<string, unknown>)
      return answerGraph(body as Record<string, unknown>)
    },
    [`POST /api/code/devices/${DEV}/git/commit`]: ({ body }) => {
      commits.push(body as Record<string, unknown>)
      return detail('c3')
    },
    [`POST /api/code/devices/${DEV}/git/cache/clear`]: () => ({ removed: 2, bytes: 3 * 1024 * 1024 }),
    ...routes,
  })
}

/** The view with a repository already picked (no job open). */
function showPicked(choice: { project: string } | { repo: string } = { project: 'anemo' }) {
  useGitViewStore.setState({ repo: { deviceId: DEV, ...choice } as never })
  return renderWithProviders(<GitView />)
}

const rows = () => screen.getAllByRole('option').filter((o) => o.hasAttribute('data-hash'))
const row = (subject: string) => rows().find((r) => r.textContent?.includes(subject))!

beforeEach(() => {
  stubMatchMedia()
  localStorage.clear()
  toasts.length = 0
  graphs = []
  commits = []
  answerGraph = () => graph()
  useGitViewStore.setState({ repo: null, allBranches: true, branchesOpen: true })
})
afterEach(() => vi.unstubAllGlobals())

describe('the Git view', () => {
  it('asks to pick a repository, and remembers the one picked', async () => {
    setup()
    renderWithProviders(<GitView />)
    expect(await screen.findByRole('heading', { name: 'Pick a repository' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Pick a repository' }))
    const list = await screen.findByRole('listbox', { name: 'Repositories' })
    expect(await within(list).findByText('On this computer')).toBeInTheDocument()
    expect(within(list).getByText('On GitHub, not cloned')).toBeInTheDocument()
    expect(within(list).getByText('o/site')).toBeInTheDocument()
    expect(within(list).queryByText('no-owner')).not.toBeInTheDocument() // no owner/name: can't be read

    await userEvent.click(within(list).getByText('o/site'))
    await waitFor(() => expect(graphs.at(-1)).toMatchObject({ repo: 'o/site', limit: 300, all: true, fetch: false }))
    expect(JSON.parse(localStorage.getItem('anemo.code.gitRepo')!)).toEqual({ deviceId: DEV, repo: 'o/site' })
  })

  it('narrows the repositories by what is searched', async () => {
    setup()
    renderWithProviders(<GitView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pick a repository' }))
    await screen.findByText('o/site')
    await userEvent.type(screen.getByRole('combobox', { name: 'Search repositories' }), 'anem')
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    expect(within(list).getByText('anemo')).toBeInTheDocument()
    expect(within(list).queryByText('o/site')).not.toBeInTheDocument()
  })

  it('shows the open job’s project', async () => {
    setup()
    const job = codeJob({ id: 'job-a', project: 'anemo', device: { ...device, name: 'Desk PC' } })
    renderWithProviders(<GitView jobId="job-a" />).client.setQueryData(codeJobKey('job-a'), { job, thread: [job] })
    await waitFor(() => expect(graphs[0]).toMatchObject({ project: 'anemo' }))
    expect(await screen.findByRole('listbox', { name: 'Commits of anemo' })).toBeInTheDocument()
  })

  it('says when there are no computers', async () => {
    mockApi({ 'GET /api/code/devices': () => [] })
    renderWithProviders(<GitView />)
    expect(await screen.findByText('No computers yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Devices' })).toHaveAttribute('href', '/settings/devices')
  })

  it('shows skeleton rows while it reads, with a calm note for a GitHub repository', async () => {
    setup({ [`POST /api/code/devices/${DEV}/git/graph`]: () => new Promise(() => {}) })
    showPicked({ repo: 'o/site' })
    expect(await screen.findByText('Reading o/site on Desk PC… The first time it is fetched, this can take a minute.')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading…')).toHaveAttribute('aria-busy', 'true')
  })

  it.each([
    ['git_unsupported', 409, 'Update Anemo Desktop on “Desk PC”', 'The Git view needs Anemo Desktop 1.5.0 or later on that computer.'],
    ['device_offline', 409, '“Desk PC” is offline', 'Turn the computer on and make sure Anemo Desktop is running there, then try again.'],
    ['device_not_trusted', 403, '“Desk PC” isn’t trusted', 'Only computers you trust can be read. You can trust it in Settings → Devices.'],
    ['device_refused', 403, '“Desk PC” didn’t let Anemo read it', 'In Anemo Desktop on that computer, turn on “Share Claude Code jobs with Anemo” (watching alone isn’t enough), then try again.'],
    ['device_unauthenticated', 409, '“Desk PC” isn’t signed in to GitHub', 'Run “gh auth login” in a terminal on that computer, then try again.'],
    ['not_found', 404, 'Repository not found', 'There’s no such folder in the computer’s projects folder, or it isn’t a git repository.'],
    ['device_busy', 409, '“Desk PC” is busy', 'It is still answering another request. Try again in a moment.'],
    ['device_failed', 422, 'Couldn’t read the repository', 'Something went wrong on the way to the computer or on it.'],
  ])('explains %s', async (code, status, title, description) => {
    answerGraph = () => answer(status, code, 'What the server said')
    setup()
    showPicked()
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(description)).toBeInTheDocument()
    if (code === 'device_not_trusted') expect(screen.getByRole('link', { name: 'Open Devices' })).toBeInTheDocument()
    else {
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(graphs).toHaveLength(2))
    }
  })

  it('asks for a newer Anemo Desktop for a GitHub repository', async () => {
    answerGraph = () => answer(409, 'git_unsupported')
    setup()
    showPicked({ repo: 'o/site' })
    expect(await screen.findByText('Reading GitHub repositories that aren’t cloned needs Anemo Desktop 1.6.0 or later on that computer.')).toBeInTheDocument()
  })

  it('says when a repository has no commits yet', async () => {
    answerGraph = () => graph({ commits: [], branches: [], head: { branch: 'main', commit: null, detached: false } })
    setup()
    showPicked()
    expect(await screen.findByText('No commits yet on main')).toBeInTheDocument()
  })

  it('draws the commits with their refs, and the working tree', async () => {
    setup()
    showPicked()
    await screen.findByText('Merge feature')
    expect(rows().map((r) => r.textContent)).toHaveLength(4)
    // HEAD and main in one pill; main's upstream is folded into it.
    const head = row('Merge feature')
    expect(within(head).getByText('HEAD')).toBeInTheDocument()
    expect(within(head).getByText('main')).toBeInTheDocument()
    expect(within(head).queryByText('origin/main')).not.toBeInTheDocument()
    expect(within(row('First')).getByText('v1.0')).toBeInTheDocument()
    // The working tree, coloured counts.
    expect(screen.getByText('2 staged')).toBeInTheDocument()
    expect(screen.getByText('3 modified')).toBeInTheDocument()
    expect(screen.getByText('1 untracked')).toBeInTheDocument()
    expect(screen.getByText('Local checkout')).toBeInTheDocument()
    expect(screen.getByText('Fetched 3 min. ago')).toBeInTheDocument()
  })

  it('says “clean” for a working tree without changes', async () => {
    answerGraph = () => graph({ status: { dirty: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } })
    setup()
    showPicked()
    expect(await screen.findByText('clean')).toBeInTheDocument()
  })

  it('links a branch’s pull request', async () => {
    setup()
    showPicked()
    await screen.findByText('First')
    const link = within(row('First')).getByRole('link', { name: /#90/ })
    expect(link).toHaveAttribute('href', 'https://github.com/o/anemo/pull/90')
    expect(link).toHaveAttribute('title', 'Pull request #90: The Git view')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('explains a detached HEAD', async () => {
    answerGraph = () => graph({
      head: { branch: null, commit: h('c2'), detached: true },
      commits: graph().commits.map((c) => (c.hash === h('c2') ? { ...c, refs: ['HEAD'] } : { ...c, refs: c.refs.filter((r) => r !== 'HEAD') })),
    })
    setup()
    showPicked()
    expect(await screen.findByText('HEAD is detached at c200000: not on a branch. New commits here belong to no branch until you create one.')).toBeInTheDocument()
    expect(screen.getByText('detached at c200000')).toBeInTheDocument()
    expect(within(row('Second')).getByTitle('HEAD is detached: not on a branch')).toHaveTextContent('HEAD· detached')
  })

  it('shows a GitHub repository without a working tree, and can clear the cached clones', async () => {
    answerGraph = () => graph({ status: null, source: 'remote', repo: 'o/site' })
    setup()
    showPicked({ repo: 'o/site' })
    await screen.findByText('Merge feature')
    expect(screen.getByText('GitHub, not cloned')).toBeInTheDocument()
    expect(screen.queryByText('clean')).not.toBeInTheDocument()
    expect(screen.queryByText(/staged/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'More Git actions' }))
    await userEvent.click(await screen.findByText('Clear cached clones on Desk PC'))
    await waitFor(() => expect(toasts).toContain('Removed 2 cached clones (3.0 MB) on Desk PC'))
  })

  it('fetches on Refresh, and shows when it fetched and what went wrong', async () => {
    setup()
    showPicked()
    await screen.findByText('Merge feature')
    answerGraph = () => graph({ fetchedAt: new Date().toISOString(), fetchError: 'Could not resolve host: github.com' })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(graphs.at(-1)).toMatchObject({ project: 'anemo', fetch: true }))
    expect(await screen.findByText('Couldn’t fetch: Could not resolve host: github.com. Showing what the computer had.')).toBeInTheDocument()
    expect(screen.getByText('Fetched just now')).toBeInTheDocument()
  })

  it('reads again without fetching when there is no remote', async () => {
    answerGraph = () => graph({ remotes: [] })
    setup()
    showPicked()
    expect(await screen.findByText('This repository has no remote: Refresh reads it again, there is nothing to fetch.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(graphs.at(-1)).toMatchObject({ fetch: false }))
  })

  it('loads more commits: 300, then 600, then 1000', async () => {
    answerGraph = (body) => graph({ truncated: body.limit !== 1000 })
    setup()
    showPicked()
    await userEvent.click(await screen.findByRole('button', { name: 'Load more commits' }))
    await waitFor(() => expect(graphs.at(-1)).toMatchObject({ limit: 600 }))
    await userEvent.click(await screen.findByRole('button', { name: 'Load more commits' }))
    await waitFor(() => expect(graphs.at(-1)).toMatchObject({ limit: 1000 }))
  })

  it('opens a commit with its message, files and changed lines; a parent selects its row', async () => {
    setup()
    showPicked()
    await userEvent.click(await screen.findByText('Merge feature'))
    const panel = await screen.findByRole('complementary', { name: 'Commit details' })
    await waitFor(() => expect(commits).toEqual([{ project: 'anemo', hash: h('c3') }]))
    expect(await within(panel).findByText('src/')).toBeInTheDocument()
    expect(within(panel).getByText('app.ts')).toBeInTheDocument()
    const files = within(panel).getByRole('list', { name: 'Changed files' })
    expect(within(files).getByText('+12')).toBeInTheDocument()
    expect(within(files).getByText('−4')).toBeInTheDocument()
    expect(within(panel).getByText('binary')).toBeInTheDocument() // logo.png has no line counts
    // The body is text: its markup is shown, not made.
    expect(within(panel).getByText(/<b>not html<\/b>/)).toBeInTheDocument()
    expect(within(panel).getByText(/committed by GitHub/)).toBeInTheDocument()
    expect(panel.querySelector('b')).toBeNull()

    await userEvent.click(within(panel).getByRole('button', { name: 'f100000' }))
    expect(row('Feature work')).toHaveAttribute('aria-selected', 'true')
  })

  it('notes that a GitHub repository’s files have no line counts', async () => {
    answerGraph = () => graph({ status: null, source: 'remote', repo: 'o/site' })
    setup({ [`POST /api/code/devices/${DEV}/git/commit`]: () => detail('c3', { files: [{ path: 'a.ts', status: 'M', additions: null, deletions: null }] }) })
    showPicked({ repo: 'o/site' })
    await userEvent.click(await screen.findByText('Merge feature'))
    expect(await screen.findByText('This repository isn’t cloned on the computer: line counts need a local clone.')).toBeInTheDocument()
    expect(screen.queryByText('binary')).not.toBeInTheDocument()
  })

  it('moves through the commits with the keyboard: arrows, Enter, Escape', async () => {
    setup()
    showPicked()
    const list = await screen.findByRole('listbox', { name: 'Commits of anemo' })
    await screen.findByText('Merge feature')
    list.focus()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(row('Merge feature')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(row('Feature work')).toHaveAttribute('aria-selected', 'true')
    expect(list).toHaveAttribute('aria-activedescendant', row('Feature work').id)
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(await screen.findByRole('complementary', { name: 'Commit details' })).toBeInTheDocument()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Commit details' })).not.toBeInTheDocument()
  })

  it('filters the branches and jumps to a branch’s tip', async () => {
    setup()
    showPicked()
    const branches = await screen.findByRole('complementary', { name: 'Branches' })
    await userEvent.type(within(branches).getByRole('searchbox', { name: 'Filter branches' }), 'feat')
    expect(within(branches).queryByText('main')).not.toBeInTheDocument()
    expect(within(branches).getByText('origin/feature')).toBeInTheDocument()
    await userEvent.click(within(branches).getByRole('button', { name: /^feature/ }))
    expect(row('Feature work')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows only what HEAD reaches when asked, and remembers it', async () => {
    setup()
    showPicked()
    await userEvent.click(await screen.findByRole('radio', { name: 'Current only' }))
    await waitFor(() => expect(graphs.at(-1)).toMatchObject({ all: false }))
    expect(localStorage.getItem('anemo.code.gitAll')).toBe('false')
  })

  it('reads the graph again when a job of the project changes state', async () => {
    setup()
    showPicked()
    await screen.findByText('Merge feature')
    expect(graphs).toHaveLength(1)
    act(() => noticeCodeJob({ job_id: 'job-x', device_id: DEV, project: 'other', state: 'done' }))
    act(() => noticeCodeJob({ job_id: 'job-y', device_id: DEV, project: 'anemo', state: 'done' }))
    await waitFor(() => expect(graphs).toHaveLength(2))
    expect(graphs[1]).toMatchObject({ project: 'anemo', fetch: false })
  })
})
