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
  await panel.getByRole('button', { name: 'Copy answer' }).click()
  await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveText('Copied')
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
  await panel.getByRole('region', { name: 'Chats' }).getByText('chat one').click()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: chat one')
})

async function chatWith(panel: import('@playwright/test').Page, text: string) {
  await panel.getByRole('button', { name: 'New chat' }).click()
  await panel.getByLabel('Message').fill(text)
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message').last()).toContainText(`You said: ${text}`)
}

test('chats can be renamed, favorited, archived and deleted, from the list and the open chat', async ({ panel }) => {
  await chatWith(panel, 'first chat')
  await chatWith(panel, 'second chat')
  // Rename the open chat from its header menu.
  await panel.getByRole('button', { name: 'Chat actions' }).click()
  await panel.getByRole('menuitem', { name: 'Rename' }).click()
  await panel.getByLabel('Title').fill('Renamed chat')
  await panel.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(panel.getByText('Renamed chat')).toBeVisible()

  await panel.getByRole('button', { name: 'All chats' }).click()
  const chats = panel.getByRole('region', { name: 'Chats' })
  // Favorite the first one: it moves into Favorites.
  await chats.getByRole('listitem').filter({ hasText: 'first chat' }).hover()
  await panel.getByRole('button', { name: 'Actions for first chat' }).click()
  await panel.getByRole('menuitem', { name: 'Add to favorites' }).click()
  await expect(chats.getByRole('region', { name: 'Favorites' })).toContainText('first chat')
  // Archive it: gone from Chats, there under Archived.
  await panel.getByRole('button', { name: 'Actions for first chat' }).click()
  await panel.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(chats).not.toContainText('first chat')
  // Undo brings it back; then archive it for good.
  await panel.getByRole('status').filter({ hasText: 'Chat archived' }).getByRole('button', { name: 'Undo' }).click()
  await expect(chats).toContainText('first chat')
  await panel.getByRole('button', { name: 'Actions for first chat' }).click()
  await panel.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(chats).not.toContainText('first chat')
  await panel.getByRole('tab', { name: 'Archived' }).click()
  await expect(chats).toContainText('first chat')
  // Delete it, after confirming.
  await panel.getByRole('button', { name: 'Actions for first chat' }).click()
  await panel.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(panel.getByRole('dialog', { name: 'Delete this chat?' })).toBeVisible()
  await panel.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(panel.getByText('Nothing archived')).toBeVisible()
  await panel.getByRole('tab', { name: 'Chats' }).click()
  await expect(chats).toContainText('Renamed chat')
})

test('a temporary chat says how long it has left and can be kept', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Temporary chat' }).click()
  await expect(panel.getByText('Deleted 5 minutes after the last message, unless you keep it.')).toBeVisible()
  await panel.getByLabel('Message').fill('off the record')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: off the record')
  const badge = panel.getByRole('button', { name: /^Temporary chat, \d:\d\d left$/ })
  await expect(badge).toBeVisible()
  await panel.getByRole('button', { name: 'All chats' }).click()
  await expect(panel.getByRole('region', { name: 'Chats' }).getByRole('region', { name: 'Temporary' })).toContainText('off the record')
  await panel.getByRole('region', { name: 'Chats' }).getByText('off the record').click()
  await badge.click()
  await panel.getByRole('button', { name: 'Keep chat' }).click()
  await expect(badge).toHaveCount(0)
})
