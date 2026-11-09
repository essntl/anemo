import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { addEvents } from './mockEvents'
import { addFocus } from './mockFocus'
import { addMusic } from './mockMusic'

test.beforeEach(async ({ panel, anemo }) => {
  const events = addEvents(anemo)
  addFocus(anemo, events)
  addMusic(anemo)
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  await expect.poll(() => events.sockets.size, { timeout: 10_000 }).toBe(1)
  await panel.getByRole('button', { name: 'Focus' }).click()
})

async function anemoTab(context: BrowserContext): Promise<Page> {
  await expect.poll(() => context.pages().find((p) => p.url().endsWith('/music'))).toBeTruthy()
  return context.pages().find((p) => p.url().endsWith('/music'))!
}

test('no Anemo tab: open the player; add a link; play, pause and skip', async ({ panel, context }) => {
  await expect(panel.getByText('Plays in Anemo. No Anemo tab is open.')).toBeVisible()
  await panel.getByRole('button', { name: 'Open Anemo’s player' }).click()
  const music = await anemoTab(context)
  await expect(panel.getByTestId('now-playing')).toHaveText('The queue is empty. Add a link below.')

  await panel.getByLabel('Link to add to the queue').fill('https://youtu.be/one')
  await panel.getByRole('button', { name: 'Add to the queue' }).click()
  await expect(panel.getByText('Added to the queue.')).toBeVisible()
  await expect(panel.getByTestId('now-playing')).toContainText('Track 1')
  await expect(panel.getByTestId('now-playing')).toContainText('Playing · 1 of 1')
  await panel.getByLabel('Link to add to the queue').fill('https://soundcloud.com/two')
  await panel.getByRole('button', { name: 'Add to the queue' }).click()
  await expect(panel.getByTestId('now-playing')).toContainText('1 of 2')
  await expect(music.locator('#queue li')).toHaveText(['Track 1', 'Track 2'])

  await panel.getByRole('button', { name: 'Pause' }).click()
  await expect(panel.getByTestId('now-playing')).toContainText('Paused')
  await panel.getByRole('button', { name: 'Next' }).click()
  await expect(panel.getByTestId('now-playing')).toContainText('Track 2')
  await panel.getByRole('button', { name: 'Previous' }).click()
  await expect(panel.getByTestId('now-playing')).toContainText('Track 1')
  expect(await music.evaluate(() => (window as unknown as { musicLog: string[] }).musicLog)).toEqual(['hello', 'add', 'add', 'toggle', 'next', 'prev'])

  await panel.getByLabel('Link to add to the queue').fill('https://example.com/nothing-here')
  await panel.getByRole('button', { name: 'Add to the queue' }).click()
  await expect(panel.getByText('Nothing playable at that link.')).toBeVisible()
})

test('an Anemo tab already open is found; a YouTube tab can be added as it is', async ({ panel, context, anemo }) => {
  const music = await context.newPage()
  await music.goto(`${anemo.url}/music`)
  await context.route('https://www.youtube.com/**', (route) => route.fulfill({ body: '<title>Song - YouTube</title>', contentType: 'text/html' }))
  const yt = await context.newPage()
  await yt.goto('https://www.youtube.com/watch?v=abc')
  await yt.bringToFront()
  await expect(panel.getByTestId('now-playing')).toHaveText('The queue is empty. Add a link below.')
  await panel.getByRole('button', { name: 'Add this tab to the queue' }).click()
  await expect(panel.getByTestId('now-playing')).toContainText('Track 1')
  await expect(music.locator('#queue li')).toHaveText(['Track 1'])
  expect(await music.evaluate(() => (window as unknown as { musicLog: string[] }).musicLog)).toContain('add')
})
