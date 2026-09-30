import { expect, test } from '@playwright/test'
import { answerPrompt, confirmWith, fakeModels, login, newChat, pickModel, send, signOutAfterEach } from './helpers'

signOutAfterEach()

test('login is required', async ({ page }) => {
  await page.goto('/settings/general')
  await expect(page).toHaveURL(/\/login\?next=/)
})

test('chat streams a reply and survives a reload mid-stream', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)

  await newChat(page, 'Chat', models.echo)
  await send(page, 'hello e2e')
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('You said: hello e2e')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Regenerate' })).toBeVisible()

  // A slow answer: reload while it streams; it must continue and finish.
  await pickModel(page, models.slow)
  const words = Array.from({ length: 24 }, (_, i) => `w${i}`).join(' ')
  await send(page, words)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(page.getByText(/You said: w0 w1/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(`You said: ${words}`)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
})

test('stop cancels the answer and keeps partial text', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.slow)
  const words = Array.from({ length: 60 }, (_, i) => `s${i}`).join(' ')
  await send(page, words)
  await expect(page.getByText(/You said: s0 s1/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('Stopped')).toBeVisible()
  await expect(page.getByText(`You said: ${words}`)).toHaveCount(0)
})

test('attach a text file and the model receives its content', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.echo)
  await page.locator('input[type=file]').setInputFiles({
    name: 'shopping.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('eggs, flour, sugar'),
  })
  await expect(page.getByText('shopping.txt')).toBeVisible()
  await expect(page.getByText('Uploading…')).toHaveCount(0)
  await send(page, 'what is on my list')
  await expect(page).toHaveURL(/\/c\//)
  // The fake model echoes everything it received, including the attachment text.
  await expect(page.getByText(/eggs, flour, sugar/).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /shopping\.txt/ })).toBeVisible()
})

test('agent asks for approval, then finishes after approval', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  // Make file listing require approval for this test; restore the user's settings after.
  const previous = ((await (await page.request.get('/api/settings')).json()) as {
    permissions: { levels?: Record<string, string> }
  }).permissions
  const changed = await page.request.put('/api/settings/permissions', {
    data: { ...previous, levels: { ...previous.levels, 'fs.read': 'ask' } },
  })
  expect(changed.ok()).toBeTruthy()
  try {
    await newChat(page, 'Agent', models.agent)
    await send(page, 'what is in my workspace?')
    await expect(page.getByText('Waiting for your approval')).toBeVisible()
    await expect(page.getByText(/The agent wants to: List/)).toBeVisible()
    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.getByText('Here is what I found:')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /\d+ actions?$/ })).toBeVisible()
  } finally {
    await page.request.put('/api/settings/permissions', { data: previous })
  }
})

test('file manager: create, edit, save, trash and restore', async ({ page }) => {
  await login(page)
  const folder = `e2e-${Date.now()}`
  try {
    await page.goto('/files')
    await page.getByRole('button', { name: 'Folder', exact: true }).click()
    await answerPrompt(page, folder)
    await page.getByRole('button', { name: folder }).click()
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await answerPrompt(page, 'note.md')
    await expect(page.getByText(`${folder}/note.md`).first()).toBeVisible()

    await page.locator('.cm-content').click()
    await page.keyboard.type('# Hello from e2e')
    await expect(page.getByText('Unsaved')).toBeVisible()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Unsaved')).toHaveCount(0)

    const saved = await page.request.get(`/api/files/content?path=${folder}/note.md`)
    expect(((await saved.json()) as { content: string }).content).toBe('# Hello from e2e')

    await page.reload()
    await expect(page.locator('.cm-content')).toContainText('# Hello from e2e')

    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'note.md' }).hover()
    await page.getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Move to trash')
    await expect(page.getByRole('button', { name: 'note.md' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).first().click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'note.md' })).toBeVisible()
  } finally {
    // Clean up: trash the folder, then remove it from the trash.
    await page.request.post('/api/files/trash', { data: { path: folder } })
    const trash = (await (await page.request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
    for (const item of trash.filter((t) => t.original_path.startsWith(folder))) {
      await page.request.delete(`/api/files/trash/${item.id}`)
    }
  }
})
