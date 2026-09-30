import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolCallView } from '../api'
import { useShellOutput } from '../shellOutput'
import { ShellDetails } from './ShellCall'

function call(overrides: Partial<ToolCallView>): ToolCallView {
  return {
    id: 'call-1',
    step: 0,
    position: 0,
    tool_name: 'run_shell',
    capability: 'shell.exec',
    args: { command: 'npm test', cwd: 'project' },
    actions: [],
    risk: 'moderate',
    decision: 'allow',
    decision_reason: null,
    status: 'running',
    result: null,
    result_data: null,
    is_error: false,
    started_at: null,
    ended_at: null,
    approval: null,
    ...overrides,
  } as ToolCallView
}

describe('ShellDetails', () => {
  beforeEach(() => useShellOutput.setState({ output: {} }))

  it('shows live output while the command runs', () => {
    useShellOutput.getState().append('call-1', 'PASS one\n')
    useShellOutput.getState().append('call-1', 'PASS two\n')
    render(<ShellDetails call={call({})} />)
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText(/PASS one\s+PASS two/)).toBeInTheDocument()
    expect(screen.getByText('running…')).toBeInTheDocument()
  })

  it('shows the stored result, exit code and stderr once finished', () => {
    const done = call({
      status: 'succeeded',
      result_data: {
        shell: {
          command: 'npm test', cwd: 'project', network: true, exit_code: 1, timed_out: false,
          truncated: false, duration_ms: 2300, stdout: 'ran 3 tests\n', stderr: '1 failed\n',
        },
      },
    })
    render(<ShellDetails call={done} />)
    expect(screen.getByText('exit 1')).toBeInTheDocument()
    expect(screen.getByText('2.3 s')).toBeInTheDocument()
    expect(screen.getByText('internet')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.queryByText('running…')).not.toBeInTheDocument()
  })

  it('keeps only the tail of very long live output', () => {
    useShellOutput.getState().append('big', 'x'.repeat(70_000))
    expect(useShellOutput.getState().output.big.length).toBe(64_000)
  })
})
