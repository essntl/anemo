import { initialRunView, runReducer, type RunEvent } from './runStream'

const apply = (events: RunEvent[]) => events.reduce(runReducer, initialRunView)

describe('runReducer', () => {
  it('accumulates text and reasoning and tracks status', () => {
    const view = apply([
      { type: 'run.status', data: { status: 'running' } },
      { type: 'run.model', data: { label: 'Echo · Fake' } },
      { type: 'reasoning.delta', data: { text: 'Thinking ' } },
      { type: 'reasoning.delta', data: { text: 'hard' } },
      { type: 'message.delta', data: { text: 'Hello ' } },
      { type: 'message.delta', data: { text: 'world' } },
      { type: 'run.status', data: { status: 'completed' } },
    ])
    expect(view).toMatchObject({
      status: 'completed',
      text: 'Hello world',
      reasoning: 'Thinking hard',
      modelLabel: 'Echo · Fake',
    })
  })

  it('discards partial output when the run is restarted', () => {
    const view = apply([
      { type: 'message.delta', data: { text: 'partial' } },
      { type: 'run.restarted', data: {} },
      { type: 'message.delta', data: { text: 'fresh' } },
    ])
    expect(view.text).toBe('fresh')
    expect(view.notice).toMatch(/interruption/)
  })

  it('captures errors from the final status', () => {
    const view = apply([{ type: 'run.status', data: { status: 'failed', error: { message: 'boom' } } }])
    expect(view.status).toBe('failed')
    expect(view.error).toBe('boom')
  })

  it('ignores unknown events', () => {
    expect(apply([{ type: 'something.new', data: {} }])).toEqual(initialRunView)
  })
})
