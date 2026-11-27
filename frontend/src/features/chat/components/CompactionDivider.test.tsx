import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { contextWarning, parseCompact } from '../compaction'
import { CompactionDivider } from './CompactionDivider'

function row(fields: Partial<Schemas['MessageOut']>): Schemas['MessageOut'] {
  return {
    id: 'c1', seq: 9, role: 'compaction', text: '## Decisions\n- use Postgres', reasoning: null,
    status: 'complete', error: null, run_id: 'r1', model_label: null, created_at: new Date().toISOString(),
    compaction: { kept_from_seq: 7, tokens_before: 312_000, tokens_after: 14_000, focus: 'the database', auto: false },
    ...fields,
  } as Schemas['MessageOut']
}

describe('the compaction divider', () => {
  it('says how much smaller the context got and opens to the summary', () => {
    render(<CompactionDivider message={row({})} />)
    const button = screen.getByRole('button', { name: /Compacted here \(312k → 14k tokens\)/ })
    expect(screen.queryByText('use Postgres')).toBeNull()
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('use Postgres')).toBeInTheDocument()
    expect(screen.getByText('Kept in detail: the database')).toBeInTheDocument()
  })

  it('shows a compaction being written, and one that failed with its error', () => {
    const { rerender } = render(<CompactionDivider message={row({ status: 'streaming', text: '', compaction: null })} />)
    expect(screen.getByRole('separator', { name: 'Compacting the chat…' })).toBeInTheDocument()
    rerender(<CompactionDivider message={row({ status: 'error', error: 'overloaded' })} />)
    expect(screen.getByRole('separator', { name: 'The chat could not be compacted' })).toHaveTextContent('overloaded')
    expect(screen.getByRole('button')).toBeDisabled()
  })
})

describe('/compact in the composer', () => {
  it('is the command alone or with a focus, nothing else', () => {
    expect(parseCompact('/compact')).toEqual({ focus: null })
    expect(parseCompact('  /compact   the API design  ')).toEqual({ focus: 'the API design' })
    expect(parseCompact('/compact\nkeep the numbers')).toEqual({ focus: 'keep the numbers' })
    expect(parseCompact('/compactor')).toBeNull()
    expect(parseCompact('please /compact')).toBeNull()
  })
})

describe('the size warning', () => {
  const context = { tokens: 100_000, compact_at: 250_000, auto_compact: true, compacts_itself: false }
  it('stays quiet until 85 %, then says when it compacts', () => {
    expect(contextWarning(context)).toBeNull()
    expect(contextWarning({ ...context, tokens: 214_000 })).toBe(
      'This chat is at 214k of 250k tokens: it will be compacted when it passes 250k (/compact does it now).')
    expect(contextWarning({ ...context, tokens: 260_000 })).toBe('This chat will be compacted before your next message.')
    expect(contextWarning({ ...context, tokens: 260_000, auto_compact: false })).toBe(
      'This chat is at 260k tokens. /compact summarizes it.')
    expect(contextWarning({ ...context, tokens: 900_000, compacts_itself: true })).toBeNull()
  })
})
