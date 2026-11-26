import { expect, test } from '@playwright/test'
import { FakeComputer, type FakeJob, jobId } from './fakeDevice'
import { login, signOutAfterEach } from './helpers'

/*
 * The Code page (docs/specs/code-sessions.md): a fake Anemo Desktop shares a Claude Code
 * job over the device WebSocket (docs/device-contracts.md §7), and the page shows it live:
 * in the list under its project, then its todo list, tool calls and result as they come.
 * A watched computer's jobs are ignored. The devices the test adds are deleted again
 * (their jobs go with them), also when the test fails.
 */

signOutAfterEach()

const suffix = () => Date.now().toString(36)

function job(id: string, project: string, prompt: string, state: FakeJob['state'] = 'running'): FakeJob {
  return {
    id,
    device_job_dir: `C:\\anemo-bridge\\jobs\\${id}`,
    project,
    dir: `C:\\dev\\${project}`,
    started: new Date().toISOString(),
    prompt,
    resume_session: null,
    model: null,
    pid: 4242,
    state,
    ended: state === 'running' ? null : new Date().toISOString(),
    branch: 'fix/calc',
    stderr_tail: null,
  }
}

const SESSION = '0b6c3f9e-7d2a-4c41-9a51-5d1f3e2a9c10'

const firstEvents = [
  { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5-5', cwd: 'C:\\dev\\calc', tools: ['Bash', 'Read', 'Edit', 'TodoWrite'] },
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_todo1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Find the bug in add()', status: 'completed', activeForm: 'Finding the bug' },
              { content: 'Run the check', status: 'in_progress', activeForm: 'Running the check' },
            ],
          },
        },
      ],
    },
  },
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'The function subtracts instead of adding. Checking it now.' },
        { type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'python -c "import calc; print(calc.add(2, 3))"' } },
      ],
    },
  },
  {
    type: 'user',
    session_id: SESSION,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: '5', is_error: false }] },
    tool_use_result: { stdout: '5', stderr: '', interrupted: false },
  },
]

const lastEvents = [
  {
    type: 'assistant',
    session_id: SESSION,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'All checks pass now.' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 4,
    duration_ms: 18_000,
    total_cost_usd: 0.0421,
    session_id: SESSION,
    result: 'Fixed `add()` in calc.py: https://github.com/essntl/calc/pull/7',
  },
]

test('a shared Claude Code job shows on the Code page and updates live', async ({ page, baseURL }) => {
  await login(page)
  const s = suffix()
  const project = `e2e-calc-${s}`
  const title = `Fix the add bug ${s}`
  let computer: FakeComputer | undefined
  let watched: FakeComputer | undefined
  try {
    computer = await FakeComputer.connect(page.request, baseURL!, `E2E Code PC ${s}`)
    const id = jobId()
    computer.job(job(id, project, `${title}\n\nThen run the check.`))
    expect(await computer.ackAtLeast(id, 0)).toBe(0)
    computer.events(id, 1, firstEvents)
    expect(await computer.ackAtLeast(id, firstEvents.length)).toBe(firstEvents.length)
    // A repeated frame is stored once: the ack doesn't move.
    computer.events(id, 1, firstEvents.slice(0, 2))
    expect(await computer.ackAtLeast(id, firstEvents.length)).toBe(firstEvents.length)

    await page.goto('/code')
    await expect(page.getByText(project).first()).toBeVisible()
    const row = page.getByTestId('code-thread').filter({ hasText: title })
    await expect(row).toBeVisible()
    await expect(row.getByText('Running', { exact: true })).toBeVisible()
    await row.click()
    await expect(page).toHaveURL(/\/code\/[0-9a-f-]{36}/)

    // The todo list, the assistant's text and the command it ran.
    await expect(page.getByText('Todo list').first()).toBeVisible()
    await expect(page.getByText('Run the check').first()).toBeVisible()
    await expect(page.getByText('The function subtracts instead of adding.').first()).toBeVisible()
    await expect(page.getByText('python -c "import calc; print(calc.add(2, 3))"').first()).toBeVisible()

    // Live: the rest of the job arrives while the page is open.
    computer.events(id, firstEvents.length + 1, lastEvents)
    const total = firstEvents.length + lastEvents.length
    expect(await computer.ackAtLeast(id, total)).toBe(total)
    computer.job(job(id, project, `${title}\n\nThen run the check.`, 'done'))
    await expect(page.getByText('All checks pass now.').first()).toBeVisible()
    await expect(page.getByText('API-equivalent cost').first()).toBeVisible()
    await expect(page.getByRole('link', { name: /github\.com\/essntl\/calc\/pull\/7|#7/ }).first()).toBeVisible()
    await expect(row.getByText('Done', { exact: true })).toBeVisible()

    // A watched computer's jobs are ignored: no ack, nothing listed.
    watched = await FakeComputer.connect(page.request, baseURL!, `E2E Code watched ${s}`, 'watched')
    const ignored = jobId()
    watched.job(job(ignored, `${project}-watched`, `Ignored ${s}`))
    await page.waitForTimeout(2000)
    expect(watched.lastAck(ignored)).toBeUndefined()
    await page.reload()
    await expect(page.getByTestId('code-thread').filter({ hasText: title })).toBeVisible()
    await expect(page.getByText(`Ignored ${s}`)).toHaveCount(0)
  } finally {
    await computer?.remove()
    await watched?.remove()
  }
})

test('the usage indicator, and a message for a running job delivered at its next step', async ({ page, baseURL }) => {
  await login(page)
  const s = suffix()
  const project = `e2e-queue-${s}`
  const title = `Refactor the parser ${s}`
  let computer: FakeComputer | undefined
  try {
    computer = await FakeComputer.connect(page.request, baseURL!, `E2E Queue PC ${s}`)
    // Anemo Desktop 1.9.0: it lets Anemo start jobs, and they take messages while they run.
    computer.offer({ control: true, code_start: true, code_input: true })
    computer.answer = (command) => ({ job_id: command.job_id, message_id: command.message_id, state: 'sent' })
    const id = jobId()
    computer.job({ ...job(id, project, title), input: true })
    expect(await computer.ackAtLeast(id, 0)).toBe(0)
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600
    const events = [
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5-5' },
      { type: 'user', message: { role: 'user', content: title }, isReplay: true, uuid: 'prompt-echo', session_id: SESSION },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed', resetsAt, rateLimitType: 'five_hour',
          unifiedWindows: {
            five_hour: { utilization: 0.49, resetsAt, status: 'allowed' },
            seven_day: { utilization: 0.25, resetsAt: resetsAt + 86400, status: 'allowed' },
          },
        },
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'npm test' } }] },
      },
    ]
    computer.events(id, 1, events)
    expect(await computer.ackAtLeast(id, events.length)).toBe(events.length)

    await page.goto('/code')
    await page.getByTestId('code-thread').filter({ hasText: title }).click()
    // The usage shows in the thread's header (and the list's); the event isn't a step of the job.
    await expect(page.getByTestId('code-usage').first()).toContainText('49%')
    await expect(page.getByTestId('code-usage').first()).toContainText('25%')
    await expect(page.getByText('Event: rate_limit_event')).toHaveCount(0)

    // A message while it runs goes to the job at once; Claude Code takes it in at its next step.
    await page.getByRole('textbox', { name: 'Message for this job' }).fill('Keep the old API working too.')
    await page.getByRole('button', { name: 'Queue message' }).click()
    const sent = await computer.command('code_input')
    expect(sent).toMatchObject({ job_id: id, prompt: 'Keep the old API working too.', now: false })
    await expect(page.getByTestId('queued-message')).toContainText('Queued: Claude Code takes it in after its current step')

    computer.events(id, events.length + 1, [
      { type: 'user', session_id: SESSION, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sleep', content: 'ok' }] } },
      { type: 'user', message: { role: 'user', content: 'Keep the old API working too.' }, isReplay: true, uuid: sent.message_id, session_id: SESSION },
    ])
    await expect(page.getByTestId('delivered-message')).toContainText('Keep the old API working too.')
    await expect(page.getByTestId('delivered-message')).toContainText('Delivered')
    await expect(page.getByTestId('queued-message')).toHaveCount(0)
  } finally {
    await computer?.remove()
  }
})

