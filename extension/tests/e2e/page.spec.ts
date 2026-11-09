import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { addChat } from './mockChat'

let chat: ReturnType<typeof addChat>
let article: Page

test.beforeEach(async ({ panel, anemo, context }) => {
  chat = addChat(anemo)
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  // The page you'd be looking at, in front; the panel stays usable behind it.
  article = await context.newPage()
  await article.goto(`${anemo.url}/article`)
  await article.bringToFront()
})

test('"Include this page" shows what will be sent, then sends it apart from the message', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Include this page' }).click()
  const chip = panel.getByTestId('page-chip')
  await expect(chip).toContainText('Photosynthesis explained')
  await expect(chip).toContainText('127.0.0.1')
  await expect(chip).toContainText('words')
  await panel.getByLabel('Message').fill('What is the main idea?')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: What is the main idea?')
  const turn = chat.turns.at(-1) as { text: string; page: { url: string; title: string; source: string; content: string } }
  expect(turn.text).toBe('What is the main idea?')
  expect(turn.page.source).toBe('page')
  expect(turn.page.url).toMatch(/\/article$/)
  // Clean Markdown of the main content: formatting and absolute links kept, menus gone.
  expect(turn.page.title).toBe('Photosynthesis explained')
  expect(turn.page.content).toContain('plants turn **light** into chemical energy')
  expect(turn.page.content).toMatch(/\[chlorophyll\]\(http:\/\/127\.0\.0\.1:\d+\/wiki\/Chlorophyll\)/)
  expect(turn.page.content).not.toContain('Log in')
  // The page is per message: off again for the next one.
  await expect(panel.getByTestId('page-chip')).toBeHidden()
  await expect(panel.getByTestId('user-message')).toContainText('Photosynthesis explained')
})

test('Summarize this page starts a new chat with the page and the summary request', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Summarize this page' }).click()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: Summarize the attached page')
  const turn = chat.turns.at(-1) as { text: string; mode: string; page: { content: string } }
  expect(turn.mode).toBe('chat')
  expect(turn.text).toContain('TL;DR')
  expect(turn.page.content).toContain('Paragraph 9')
})

test('Quiz me asks for five questions, one at a time', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Quiz me on it' }).click()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: Quiz me on the attached page')
  expect(String((chat.turns.at(-1) as { text: string }).text)).toMatch(/5 questions in total, one at a time/)
})

test('a page Chrome forbids is explained, not sent', async ({ panel, context }) => {
  const settings = await context.newPage()
  await settings.goto('chrome://version')
  await settings.bringToFront()
  await panel.getByRole('button', { name: 'Include this page' }).click()
  await expect(panel.getByText('This page can’t be read')).toBeVisible()
})
