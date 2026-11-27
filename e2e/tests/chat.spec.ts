import { expect, test } from '@playwright/test'
import { answerPrompt, confirmWith, fakeModels, login, newAgentChatWithLevels, newChat, pickModel, send, signOutAfterEach } from './helpers'

signOutAfterEach()

test('login is required', async ({ page }) => {
  await page.goto('/settings/general')
  await expect(page).toHaveURL(/\/login\?next=/)
})

test('signing out goes to the login page, and the app stays closed', async ({ page }) => {
  await login(page)
  await page.locator('aside').first().getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Password')).toBeVisible()
  await page.goto('/chats')
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

test('nothing in a long chat lets the page scroll away from it', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.echo)
  await send(page, 'a long chat')
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('You said: a long chat')).toBeVisible()
  // A long history with something positioned at its end, as the sr-only label of a running
  // tool's timer: it used to be placed on the page under the chat, which could then be
  // scrolled into empty space below the message box.
  const main = page.locator('main')
  await page.getByText('You said: a long chat').evaluate((answer) => {
    const tall = document.createElement('div')
    tall.style.height = '3000px'
    const label = document.createElement('span')
    label.className = 'sr-only'
    label.textContent = 'running since 10:00'
    answer.append(tall, label)
  })
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0)
  await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
})

test('the skills menu fits on the new chat screen, also in a short window', async ({ page }) => {
  await login(page)
  for (const height of [900, 600]) {
    await page.setViewportSize({ width: 1280, height })
    await page.goto('/')
    const box = page.locator('main textarea').first()
    await box.fill('/')
    const menu = page.getByRole('listbox', { name: 'Skills' })
    await expect(menu).toBeVisible()
    // Not cut off by the page (its top was hidden above the page's edge): the whole menu,
    // its heading to "Manage skills", is inside what the page shows.
    const cut = await menu.evaluate((list) => {
      const rect = list.parentElement!.getBoundingClientRect()
      let top = 0
      let bottom = window.innerHeight
      for (let el = list.parentElement!.parentElement; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowY === 'visible') continue
        const r = el.getBoundingClientRect()
        top = Math.max(top, r.top)
        bottom = Math.min(bottom, r.bottom)
      }
      return { above: top - rect.top, below: rect.bottom - bottom }
    })
    expect(cut.above).toBeLessThanOrEqual(0)
    expect(cut.below).toBeLessThanOrEqual(0)
    await expect(page.getByRole('link', { name: 'Manage skills' })).toBeInViewport()
    await box.press('Escape')
  }
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

test('the agent asks a question; tap a suggested answer, or type one in the message box', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Agent', models.agent)
  await send(page, 'Paint the fence, but ask me first')
  await expect(page).toHaveURL(/\/c\//)
  const card = page.getByRole('group', { name: "The agent's question" })
  await expect(card.getByText('Which colour do you want?')).toBeVisible()
  await expect(page.getByText('The agent has a question for you')).toBeVisible()
  // Tap a suggestion: the agent goes on with it.
  await card.getByRole('button', { name: 'Green' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByText('Thanks. The user answered: Green')).toBeVisible()

  // Next time, answer in the message box instead.
  await send(page, 'And the gate? Ask me again')
  await expect(card.getByText('Which colour do you want?')).toBeVisible()
  const box = page.getByPlaceholder('Answer the agent’s question…')
  await box.fill('Blue, with white edges')
  await box.press('Enter')
  await expect(card).toHaveCount(0)
  await expect(page.getByText('Thanks. The user answered: Blue, with white edges')).toBeVisible()
  // The question stays in the run's activity with the answer.
  await page.getByRole('button', { name: '1 action', exact: true }).last().click()
  await expect(page.getByText('Ask you: Which colour do you want?').last()).toBeVisible()
  await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
})

test('agent asks for approval, then finishes after approval', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  // File listing asks first in this chat (its own agent profile; the settings stay).
  let profile = ''
  try {
    profile = await newAgentChatWithLevels(page, models.agent, { 'fs.read': 'ask' })
    await send(page, 'what is in my workspace?')
    await expect(page.getByText('Waiting for your approval')).toBeVisible()
    await expect(page.getByText(/The agent wants to: List/)).toBeVisible()
    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.getByText('Here is what I found:')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /\d+ actions?$/ })).toBeVisible()
  } finally {
    if (profile) await page.request.delete(`/api/profiles/${profile}`)
    if (page.url().includes('/c/')) await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
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

test('opening another chat from the sidebar starts with an empty message box', async ({ page }) => {
  await login(page)
  const make = async (title: string) => {
    const c = await (await page.request.post('/api/conversations', { data: {} })).json()
    await page.request.patch(`/api/conversations/${c.id}`, { data: { title } })
    return c.id as string
  }
  const first = await make(`Draft A ${Date.now()}`)
  const second = await make(`Draft B ${Date.now()}`)
  await page.goto(`/c/${first}`)
  const box = page.getByPlaceholder(/Message the assistant/)
  await box.fill('half a thought for chat A')
  // Within the app (no page load), as when clicking another chat in the sidebar.
  await page.locator(`aside a[href="/c/${second}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(second))
  await expect(page.getByPlaceholder(/Message the assistant/)).toHaveValue('')
  for (const id of [first, second]) await page.request.delete(`/api/conversations/${id}`)
})
