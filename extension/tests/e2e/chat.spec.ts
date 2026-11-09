import { expect, test } from './fixtures'
import { addChat } from './mockChat'

test.beforeEach(async ({ panel, anemo }) => {
  addChat(anemo)
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
})

test('sends a message and streams the answer', async ({ panel }) => {
  await panel.getByLabel('Message').fill('hello there')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: hello there')
  await expect(panel.getByTestId('user-message')).toHaveText('hello there')
})

test('reopening the panel resumes the chat and its draft', async ({ panel }) => {
  await panel.getByLabel('Message').fill('first message')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: first message')
  await panel.getByLabel('Message').fill('half-written')
  await panel.waitForTimeout(200)
  await panel.reload()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: first message')
  await expect(panel.getByLabel('Message')).toHaveValue('half-written')
})

test('an answer still being written is picked up after the panel was closed', async ({ panel }) => {
  await panel.getByLabel('Message').fill('slow one two three four five six seven eight')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible()
  await panel.reload()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: slow one two three four five six seven eight', { timeout: 10_000 })
})

test('stop cancels the run', async ({ panel }) => {
  await panel.getByLabel('Message').fill('slow a b c d e f g h i j')
  await panel.getByLabel('Message').press('Enter')
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByText('Stopped.')).toBeVisible()
})

test('an approval card shows the action and its details; allowing lets the run finish', async ({ panel, anemo }) => {
  await panel.getByRole('radio', { name: 'agent' }).click()
  await panel.getByLabel('Message').fill('needs approval please')
  await panel.getByLabel('Message').press('Enter')
  const card = panel.getByTestId('approval-card')
  await expect(card).toContainText('The agent wants to: Write notes/todo.md')
  await card.getByRole('button', { name: 'details' }).click()
  await expect(card).toContainText('notes/todo.md')
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card).toBeHidden()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: needs approval please')
  expect(anemo.log.some((l) => l.startsWith('POST /api/approvals/'))).toBe(true)
})

test('the chat list opens an earlier chat', async ({ panel }) => {
  await panel.getByLabel('Message').fill('chat one')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: chat one')
  await panel.getByRole('button', { name: 'New chat' }).click()
  await panel.getByLabel('Message').fill('chat two')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: chat two')
  await panel.getByRole('button', { name: 'All chats' }).click()
  await panel.getByRole('list', { name: 'Chats' }).getByText('chat one').click()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: chat one')
})
