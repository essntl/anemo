import { describe, expect, it } from 'vitest'
import { initialRunView, runReducer, type RunEvent } from './runReducer'

const apply = (events: RunEvent[]) => events.reduce(runReducer, initialRunView)

describe('runReducer', () => {
  it('builds the answer from deltas and follows the status', () => {
    const v = apply([
      { type: 'run.status', data: { status: 'running' } },
      { type: 'run.model', data: { label: 'Qwen' } },
      { type: 'message.delta', data: { text: 'Hel' } },
      { type: 'message.delta', data: { text: 'lo' } },
      { type: 'run.status', data: { status: 'completed' } },
    ])
    expect(v).toMatchObject({ status: 'completed', text: 'Hello', modelLabel: 'Qwen' })
  })

  it('keeps an error message and drops streamed text on a restart', () => {
    expect(apply([{ type: 'run.status', data: { status: 'failed', error: { message: 'Provider down' } } }]).error).toBe('Provider down')
    const v = apply([{ type: 'message.delta', data: { text: 'old' } }, { type: 'run.restarted', data: {} }])
    expect(v.text).toBe('')
  })

  it('counts timeline changes so the tool list reloads', () => {
    const v = apply([{ type: 'tool.started', data: {} }, { type: 'approval.requested', data: {} }])
    expect(v.timelineVersion).toBe(2)
  })
})
