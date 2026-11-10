import { describe, expect, it } from 'vitest'
import type { ToolCallView } from './api'
import { pendingApproval, pendingQuestion } from './question'

const call = (id: string, status: string, kind: string | null, approval = 'pending') =>
  ({ id, status, args: {}, approval: kind ? { id: `a-${id}`, kind, status: approval, summary: '' } : null }) as unknown as ToolCallView

describe('what a run waits for', () => {
  it('a plain approval is the one to allow or deny', () => {
    const calls = [call('1', 'completed', 'action', 'approved'), call('2', 'waiting_approval', 'action')]
    expect(pendingApproval(calls)?.id).toBe('2')
    expect(pendingQuestion(calls)).toBeUndefined()
  })

  it('a plan to review or a question is not an approval to allow', () => {
    expect(pendingApproval([call('1', 'waiting_approval', 'plan')])).toBeUndefined()
    const question = [call('2', 'waiting_approval', 'question')]
    expect(pendingApproval(question)).toBeUndefined()
    expect(pendingQuestion(question)?.id).toBe('2')
  })

  it('nothing waits in a run without calls, or once it was decided', () => {
    expect(pendingApproval(undefined)).toBeUndefined()
    expect(pendingApproval([call('1', 'completed', 'action', 'approved')])).toBeUndefined()
  })
})
