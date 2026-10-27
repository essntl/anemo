import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Music: a track is added by pasting a link and plays; the queue is saved as a playlist
 * on the server. The links are the app's own sound files, so no internet is needed.
 * Everything created is removed again.
 */

signOutAfterEach()

test('add a track, play it, and save the queue as a playlist', async ({ page, baseURL }) => {
  await login(page)
  await page.goto('/music')
  const link = `${baseURL}/sounds/timer.mp3`
  const name = `E2E playlist ${Date.now()}`
  let playlistId: string | undefined
  try {
    await page.getByRole('textbox', { name: 'Music link' }).fill('not a link')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('That is not a link')

    await page.getByRole('textbox', { name: 'Music link' }).fill(link)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByTestId('queue-item')).toHaveCount(1)
    await expect(page.getByTestId('queue-item')).toContainText('timer')
    // The queue was empty, so it starts playing.
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

    // Saved to the library on the server.
    await expect
      .poll(async () => ((await (await page.request.get('/api/music/tracks')).json()) as { url: string }[]).some((t) => t.url === link))
      .toBe(true)

    await page.getByRole('button', { name: 'Queue options' }).click()
    await page.getByRole('button', { name: 'Save as playlist' }).click()
    await page.getByRole('dialog').getByRole('textbox').fill(name)
    await page.getByRole('dialog').getByRole('textbox').press('Enter')
    await expect(page.getByRole('tab', { name: /^Playlists/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(name)).toBeVisible()
    const playlists = (await (await page.request.get('/api/music/playlists')).json()) as { id: string; name: string; tracks: { url: string }[] }[]
    const saved = playlists.find((p) => p.name === name)
    playlistId = saved?.id
    expect(saved?.tracks.map((t) => t.url)).toEqual([link])

    // Space plays and pauses on this page.
    await page.locator('h1', { hasText: 'Music' }).click()
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  } finally {
    if (playlistId) await page.request.delete(`/api/music/playlists/${playlistId}`)
    const tracks = (await (await page.request.get('/api/music/tracks')).json()) as { id: string; url: string }[]
    for (const t of tracks.filter((x) => x.url === link)) await page.request.delete(`/api/music/tracks/${t.id}`)
  }
})
