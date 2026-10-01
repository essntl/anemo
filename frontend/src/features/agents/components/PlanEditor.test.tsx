import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { type EditableStep, planIsValid, toEditable } from '../plan'
import { PlanEditor } from './PlanEditor'

function Harness({ initial, onChange }: { initial: EditableStep[]; onChange: (s: EditableStep[]) => void }) {
  const [steps, setSteps] = useState(initial)
  return <PlanEditor steps={steps} onChange={(s) => { setSteps(s); onChange(s) }} />
}

describe('PlanEditor', () => {
  it('renames, reorders, removes and adds steps, keeping their status', async () => {
    const user = userEvent.setup()
    let latest: EditableStep[] = []
    render(
      <Harness
        initial={toEditable([{ title: 'Read notes', status: 'done' }, { title: 'Write summary', status: 'pending' }])}
        onChange={(s) => (latest = s)}
      />,
    )
    await user.type(screen.getByLabelText('Step 2'), ' in English')
    await user.click(screen.getAllByRole('button', { name: 'Move up' })[1])
    expect(latest).toEqual([
      { title: 'Write summary in English', status: 'pending' },
      { title: 'Read notes', status: 'done' },
    ])
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    expect(planIsValid(latest)).toBe(false) // the new step has no title yet
    await user.click(screen.getAllByRole('button', { name: 'Remove step' })[2])
    expect(latest).toHaveLength(2)
    expect(planIsValid(latest)).toBe(true)
  })

  it('reads loosely typed plans from the API', () => {
    expect(toEditable([{ title: 'x', status: 'weird' }, { title: 3 }])).toEqual([
      { title: 'x', status: 'pending' },
      { title: '3', status: 'pending' },
    ])
  })
})
