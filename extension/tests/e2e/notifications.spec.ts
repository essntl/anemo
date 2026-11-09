import type { Worker } from '@playwright/test'
import { expect, test } from './fixtures'
import { addChat } from './mockChat'
import { addEvents, type MockEvents } from './mockEvents'
import { send } from './mockAnemo'

let events: MockEvents
let worker: Worker

const notificationIds = () => worker.evaluate(async () => Object.keys(await chrome.notifications.getAll()))

test.beforeEach(async ({ panel, anemo, context }) => {
  addChat(anemo)
  events = addEvents(anemo)
  anemo.routes.set('GET /api/approvals', (_r, _b, res) => send(res, 200, [{ id: 'a1', run_id: 'run-9', conversation_id: 'c9', summary: 'Delete old drafts', created_at: new Date().toISOString(), kind: 'action', status: 'pending', tool_name: 'delete_file' }]))
  anemo.routes.set('GET /api/notifications', (_r, _b, res) => send(res, 200, []))
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  worker = context.serviceWorkers()[0]
  await expect.poll(() => events.sockets.size, { timeout: 10_000 }).toBe(1)
})

test('the worker says hello with the token, then shows Anemo’s notifications', async () => {
  expect(events.hellos[0]).toMatchObject({ type: 'hello', token: 'anemo_good-token' })
  events.publish('notification', { id: 'n1', title: 'Reminder: Lecture', body: 'At 14:00', kind: 'reminder', link: '/calendar' })
  await expect.poll(notificationIds).toContain('n:n1')
})

test('an approval request becomes a notification with the request in it, and the badge counts it', async () => {
  events.publish('approval.requested', { run_id: 'run-9', conversation_id: 'c9' })
  await expect.poll(notificationIds).toContain('approval:c9')
  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}))
  expect(badge).toBe('1')
})

test('a type switched off in settings is not shown', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Settings' }).click()
  await panel.getByRole('switch', { name: 'Reminders and due tasks' }).click()
  await expect(panel.getByRole('switch', { name: 'Reminders and due tasks' })).toHaveAttribute('aria-checked', 'false')
  events.publish('notification', { id: 'n2', title: 'Due: essay', kind: 'reminder', link: '/tasks' })
  events.publish('notification', { id: 'n3', title: 'Daily digest', kind: 'automation', link: '/c/0192aabb-cc' })
  await expect.poll(notificationIds).toContain('n:n3')
  expect(await notificationIds()).not.toContain('n:n2')
})

test('revoking the token closes the stream and the panel goes back to setup', async ({ panel }) => {
  events.closeAll(4401)
  await expect(panel.getByText('The token stopped working')).toBeVisible()
})

test('the settings show the live connection', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Settings' }).click()
  await expect(panel.getByText('Live: connected')).toBeVisible()
})

test('events missed while disconnected are replayed; more than three become one summary', async () => {
  events.closeAll(1001) // the connection drops (not a revocation)
  await expect.poll(() => events.sockets.size).toBe(0)
  for (const n of [1, 2, 3, 4]) events.publish('notification', { id: `m${n}`, title: `Reminder ${n}`, kind: 'reminder', link: '/tasks' })
  // The worker reconnects on its own, resumes from the last event it saw, and catches up.
  await expect.poll(() => events.sockets.size, { timeout: 15_000 }).toBe(1)
  expect(events.hellos.at(-1)?.last_id).toBeTruthy()
  await expect.poll(notificationIds, { timeout: 10_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^summary:missed:/)]))
  expect((await notificationIds()).filter((id) => id.startsWith('n:m'))).toEqual([])
})

test('the panel shows the live connection’s state and where an approval is waiting', async ({ panel }) => {
  await expect(panel.getByTestId('status-dot')).toHaveAttribute('data-state', 'connected')
  events.publish('approval.requested', { run_id: 'run-9', conversation_id: 'c9' })
  const bar = panel.getByRole('button', { name: /Waiting for your approval/ })
  await expect(bar).toContainText('Delete old drafts')
  // Anemo goes away: the dot says so (and the worker opens no socket until it is back).
  events.closeAll(1012)
  await expect(panel.getByTestId('status-dot')).not.toHaveAttribute('data-state', 'connected')
  await expect(panel.getByTestId('status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
})
