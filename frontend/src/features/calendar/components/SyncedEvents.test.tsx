import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EventContentArg, EventInput } from '@fullcalendar/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let trashed: { item_id: string }[] = []
vi.mock('@/features/trash/api', () => ({ useTrashed: () => ({ data: trashed }) }))

const { DayList } = await import('./DayList')
const { SyncedEventContent } = await import('./SyncedEventContent')
const { MissingEventNotice } = await import('./MissingEventNotice')
const { onSourceLink } = await import('@/features/provenance/labels')

const synced = { source: 'artemk', external_key: 'artemk:booking:123', source_url: 'https://artemk.example/b/123' }
const occurrence = { id: 'e1', event_id: 'e1', title: 'Meeting website', ...synced }
const entry = (props: object): EventInput => ({ id: 'e1:1', title: 'Meeting website', start: '2026-12-05T10:00:00', allDay: false, extendedProps: { occurrence: { ...occurrence, ...props } } })

beforeEach(() => {
  trashed = []
})

describe('synced events in the calendar', () => {
  it('show their source badge in the day list, and a click on it does not open the event', async () => {
    const onOpen = vi.fn()
    render(<DayList day="2026-12-05" entries={[entry({})]} onOpen={onOpen} />)
    const badge = screen.getByRole('link')
    expect(badge.getAttribute('href')).toBe('https://artemk.example/b/123')
    expect(badge.closest('button')).toBeNull() // a link of its own, not inside the row's button
    fireEvent.click(badge)
    expect(onOpen).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Meeting website/ }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('show no badge for ordinary events', () => {
    render(<DayList day="2026-12-05" entries={[entry({ source: null, external_key: null, source_url: null })]} onOpen={() => {}} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('show it on their chips in the month and week views, where a click on it is told apart', () => {
    const arg = { view: { type: 'dayGridMonth' }, event: { allDay: false, title: 'Meeting website' }, timeText: '10:00' } as unknown as EventContentArg
    render(<SyncedEventContent arg={arg} occurrence={occurrence as never} />)
    const badge = screen.getByRole('link')
    expect(badge.textContent).toContain('artemk')
    expect(screen.getByText('10:00')).toBeTruthy()
    expect(onSourceLink(badge.querySelector('svg'))).toBe(true)
    expect(onSourceLink(screen.getByText('Meeting website'))).toBe(false)
  })

  it('leave the time to its own column in the agenda', () => {
    const arg = { view: { type: 'listWeek' }, event: { allDay: false, title: 'Meeting website' }, timeText: '10:00' } as unknown as EventContentArg
    render(<SyncedEventContent arg={arg} occurrence={occurrence as never} />)
    expect(screen.queryByText('10:00')).toBeNull()
    expect(screen.getByRole('link')).toBeTruthy()
  })
})

describe('a link to an event that is not there', () => {
  it('says it may have been deleted', async () => {
    const onClose = vi.fn()
    render(<MissingEventNotice eventId="gone" onOpenTrash={() => {}} onClose={onClose} />)
    expect(screen.getByText('Event not found. It may have been deleted.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open the trash' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('says so when it is in the trash, with a way there', async () => {
    trashed = [{ item_id: 'e9' }]
    const onOpenTrash = vi.fn()
    render(<MissingEventNotice eventId="e9" onOpenTrash={onOpenTrash} onClose={() => {}} />)
    expect(screen.getByText('This event is in the trash.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Open the trash' }))
    expect(onOpenTrash).toHaveBeenCalledOnce()
  })
})
