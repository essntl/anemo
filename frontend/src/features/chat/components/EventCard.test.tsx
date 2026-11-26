import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventCard } from './EventCard'

describe('the event card', () => {
  it('says an event woke the chat, what it was, and how many came at once', () => {
    render(<EventCard event={{ event_type: 'code_job.ended', summary: 'Claude Code job ended (done): Fix the tests',
      at: new Date().toISOString(), coalesced: 3, trigger_id: 't1' }} />)
    const card = screen.getByRole('note', { name: 'An event woke this chat' })
    expect(card).toHaveTextContent('Claude Code job ended (done): Fix the tests')
    expect(card).toHaveTextContent('3 events in a short time')
  })
})
