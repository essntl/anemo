import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NeedsRow } from '@/features/home/useNeedsYou'
import type { InProgressItem } from './useInProgress'

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
const note = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, body: '', level: 'info', kind: 'agent', link: null, read_at: null, created_at: iso(0.1), ...over,
})

const mocks = vi.hoisted(() => ({
  rows: [] as NeedsRow[],
  progress: [] as InProgressItem[],
  notes: [] as ReturnType<typeof note>[],
  decide: vi.fn(),
  markRead: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/features/home/useNeedsYou', () => ({ useNeedsYou: () => ({ rows: mocks.rows, ready: true }) }))
vi.mock('./useInProgress', () => ({ useInProgress: () => ({ items: mocks.progress, ready: true }) }))
vi.mock('@/features/agents/api', () => ({ useDecide: () => ({ mutate: mocks.decide, isPending: false }) }))
vi.mock('./api', () => ({
  useNotifications: (unreadOnly: boolean) => ({
    data: { pages: [unreadOnly ? mocks.notes.filter((n) => !n.read_at) : mocks.notes] },
    isSuccess: true, isError: false, hasNextPage: false,
  }),
  useNotificationSummary: () => ({ data: { unread: mocks.notes.filter((n) => !n.read_at).length } }),
  useMarkRead: () => ({ mutate: mocks.markRead, isPending: false }),
  useDeleteNotification: () => ({ mutate: mocks.remove }),
  useClearNotifications: () => ({ mutate: vi.fn() }),
}))

const { NotificationsPage } = await import('./NotificationsPage')
const show = () => render(<MemoryRouter><NotificationsPage /></MemoryRouter>)
const section = (name: string) => screen.getByRole('region', { name: new RegExp(name) })

// jsdom has no matchMedia (the row menu asks it for the phone layout): a desktop.
beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'), media: query, addEventListener: () => {}, removeEventListener: () => {},
  }))
})

beforeEach(() => {
  mocks.rows = []
  mocks.progress = []
  mocks.notes = []
  vi.clearAllMocks()
})

describe('the Inbox', () => {
  it('counts each part at the top and says when nothing waits or runs', () => {
    mocks.notes = [note('1', 'Done'), note('2', 'Seen', { read_at: iso(1) })]
    show()
    const overview = screen.getByRole('navigation', { name: 'Inbox overview' })
    expect(overview).toHaveTextContent('0 need you')
    expect(overview).toHaveTextContent('0 in progress')
    expect(overview).toHaveTextContent('1 unread')
    expect(section('Needs you')).toHaveTextContent('Nothing needs you right now.')
    expect(section('In progress')).toHaveTextContent('Nothing is running.')
  })

  it('allows or denies an approval in place', async () => {
    mocks.rows = [{ key: 'a-1', kind: 'approval', title: 'Approval needed', detail: 'Delete a.txt', to: '/c/9', approval: { id: 'ap1', runId: 'r1' } }]
    show()
    const needs = section('Needs you')
    await userEvent.click(within(needs).getByRole('button', { name: 'Deny' }))
    expect(mocks.decide).toHaveBeenCalledWith({ approvalId: 'ap1', decision: 'deny', scope: 'once' }, expect.anything())
    await userEvent.click(within(needs).getByRole('button', { name: 'Allow once' }))
    expect(mocks.decide).toHaveBeenLastCalledWith({ approvalId: 'ap1', decision: 'approve', scope: 'once' }, expect.anything())
  })

  it('answers a question with a suggested answer or its own text', async () => {
    mocks.rows = [{
      key: 'q-1', kind: 'question', title: 'Where?', to: '/c/9',
      question: { id: 'q1', runId: 'r1', text: 'Where?', options: ['Downtown', 'Harbour'], multiple: false },
    }]
    show()
    const needs = section('Needs you')
    await userEvent.click(within(needs).getByRole('button', { name: 'Harbour' }))
    expect(mocks.decide).toHaveBeenCalledWith({ approvalId: 'q1', decision: 'approve', answer: 'Harbour' }, expect.anything())
    await userEvent.type(within(needs).getByRole('textbox', { name: 'Your answer' }), 'At home{Enter}')
    expect(mocks.decide).toHaveBeenLastCalledWith({ approvalId: 'q1', decision: 'approve', answer: 'At home' }, expect.anything())
    expect(within(needs).getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', '/c/9')
  })

  it('links a review to where it is done', () => {
    mocks.rows = [{ key: 'p-x', kind: 'review', title: 'Plugin to review: Weather', to: '/settings/plugins/weather' }]
    show()
    expect(within(section('Needs you')).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/settings/plugins/weather')
  })

  it('lists what is running, each linking to it', () => {
    mocks.progress = [
      { key: 'j-1', kind: 'job', title: 'Fix the login bug', detail: 'anemo · desk', since: iso(0.5), to: '/code/1' },
      { key: 'w-1', kind: 'wake', title: 'Weekly plan', detail: 'When the job finishes', since: iso(2), to: '/c/7' },
    ]
    show()
    const running = section('In progress')
    expect(within(running).getByRole('link', { name: /Fix the login bug/ })).toHaveAttribute('href', '/code/1')
    expect(within(running).getByRole('link', { name: /Weekly plan.*When the job finishes/ })).toHaveAttribute('href', '/c/7')
    expect(within(running).getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', '/code')
  })

  it('groups notifications by day and filters them by kind', async () => {
    mocks.notes = [
      note('1', 'Job finished: fix login', { link: '/code/1' }),
      note('2', 'Reminder: dentist', { kind: 'reminder', created_at: iso(24 * 5) }),
    ]
    show()
    const list = section('Notifications')
    expect(within(list).getByRole('list', { name: 'Today' })).toHaveTextContent('Job finished: fix login')
    expect(within(list).getByRole('list', { name: 'Earlier' })).toHaveTextContent('Reminder: dentist')
    await userEvent.click(within(list).getByRole('button', { name: /Reminders\s*1/ }))
    expect(within(list).queryByText('Job finished: fix login')).toBeNull()
    expect(within(list).getByText('Reminder: dentist')).toBeInTheDocument()
  })

  it('moves between notifications with the arrow keys; M marks read, Delete dismisses', async () => {
    mocks.notes = [note('1', 'First'), note('2', 'Second')]
    show()
    const [first, second] = within(section('Notifications')).getAllByRole('listitem')
    first.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(second)
    await userEvent.keyboard('m')
    expect(mocks.markRead).toHaveBeenCalledWith(['2'])
    await userEvent.keyboard('{ArrowUp}{Delete}')
    expect(mocks.remove).toHaveBeenCalledWith('1', expect.anything())
  })

  it('says when a filter leaves nothing', async () => {
    mocks.notes = [note('1', 'Seen', { read_at: iso(1) })]
    show()
    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }))
    expect(section('Notifications')).toHaveTextContent('Nothing unread')
  })
})
