import { expect, type Browser, type Page, test } from '@playwright/test'
import { fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * Share links: a read-only copy of a chat, document or project for anyone who has the address.
 * The visitor is a separate browser without cookies, so it really is "not logged in".
 * Chats made here have a unique name and are deleted afterwards, which also removes
 * their links. "Revoke all" is never pressed: on a real install it would withdraw the
 * owner's own links.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

async function deleteChats(page: Page, mark: string) {
  const r = await page.request.get(`/api/conversations?limit=500&q=${mark}`)
  for (const c of (await r.json()) as { id: string }[]) await page.request.delete(`/api/conversations/${c.id}`)
}

async function visitorPage(browser: Browser, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport })
  return { context, visitor: await context.newPage() }
}

test('share a chat by link, read it without logging in, then revoke it', async ({ page, browser }) => {
  const mark = `shr${suffix()}`
  const title = `Trip ${mark}`
  await login(page)
  const { context, visitor } = await visitorPage(browser, { width: 375, height: 800 })
  try {
    await page.request.post('/api/conversations', { data: { title } })

    // Share it from the list of all chats.
    await page.goto(`/chats?q=${mark}`)
    await page.getByRole('main').getByRole('button', { name: `Actions for ${title}` }).click()
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: `Share “${title}”` })).toBeVisible()
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const url = await dialog.getByLabel('Link', { exact: true }).inputValue()
    expect(url).toMatch(/\/s\/[\w-]{40,}$/)
    await expect(dialog.getByText('Opened 0 times')).toBeVisible()

    // Someone without a login opens it, on a phone.
    await visitor.goto(url)
    await expect(visitor.getByRole('heading', { name: title })).toBeVisible()
    await expect(visitor.getByText('shared chat, read-only')).toBeVisible()
    // A copy to read, nothing else: no menu, nothing to type in or press.
    await expect(visitor.locator('aside')).toHaveCount(0)
    await expect(visitor.getByRole('textbox')).toHaveCount(0)
    await expect(visitor.getByRole('button')).toHaveCount(0)
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // The link opens this copy only; the rest still needs a login.
    expect((await visitor.request.get(new URL('/api/conversations', url).toString())).status()).toBe(401)
    await visitor.goto(new URL('/chats', url).toString())
    await expect(visitor).toHaveURL(/\/login/)

    // It is listed under Settings, with what it points to.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.goto('/settings/sharing')
    const row = page.getByRole('group', { name: `Link to ${title}` })
    await expect(row.getByText('Opened once')).toBeVisible()

    // Revoke it (asks first): the link stops working.
    await row.getByRole('button', { name: 'Revoke' }).click()
    await expect(row.getByText('Stop this link working?')).toBeVisible()
    await row.getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveCount(0)
    await visitor.goto(url)
    await expect(visitor.getByRole('heading', { name: 'This link is no longer available' })).toBeVisible()
  } finally {
    await context.close()
    await deleteChats(page, mark)
  }
})

test('a shared chat shows its messages and only changes when the copy is updated', async ({ page, browser }) => {
  await login(page)
  const models = await fakeModels(page.request) // skips without the fake provider
  const mark = `cpy${suffix()}`
  const { context, visitor } = await visitorPage(browser)
  try {
    await newChat(page, 'Chat', models.echo)
    await send(page, `The ferry leaves at nine ${mark}`)
    await expect(page.getByText(`You said: The ferry leaves at nine ${mark}`)).toBeVisible()

    await page.getByRole('button', { name: 'Chat actions' }).click()
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const url = await dialog.getByLabel('Link', { exact: true }).inputValue()

    await visitor.goto(url)
    await expect(visitor.getByText(`The ferry leaves at nine ${mark}`, { exact: true })).toBeVisible()
    await expect(visitor.getByText(`You said: The ferry leaves at nine ${mark}`)).toBeVisible()

    // The chat goes on; the copy does not.
    await page.keyboard.press('Escape')
    await send(page, `Actually it leaves at ten ${mark}`)
    await expect(page.getByText(`You said: Actually it leaves at ten ${mark}`)).toBeVisible()
    await visitor.reload()
    await expect(visitor.getByText(`You said: The ferry leaves at nine ${mark}`)).toBeVisible()
    await expect(visitor.getByText(`Actually it leaves at ten ${mark}`)).toHaveCount(0)

    // "Update copy": same link, new content.
    await page.getByRole('button', { name: 'Chat actions' }).click()
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const refreshed = page.waitForResponse((r) => r.url().includes('/refresh') && r.ok())
    await dialog.getByRole('button', { name: 'Update copy' }).click()
    await refreshed
    expect(await dialog.getByLabel('Link', { exact: true }).inputValue()).toBe(url)
    await visitor.reload()
    await expect(visitor.getByText(`You said: Actually it leaves at ten ${mark}`)).toBeVisible()
  } finally {
    await context.close()
    const id = page.url().split('/c/')[1]
    if (id) await page.request.delete(`/api/conversations/${id}`)
  }
})

test('a shared document, and a shared project whose documents can be read in full', async ({ page, browser }) => {
  await login(page)
  await fakeModels(page.request) // creates a project (folders in the workspace): test installs only
  const name = `Garden ${suffix()}`
  const { context, visitor } = await visitorPage(browser, { width: 375, height: 800 })
  let projectId = ''
  let documentId = ''
  try {
    const project = (await (await page.request.post('/api/projects', { data: { name, instructions: 'never shown' } })).json()) as { id: string; slug: string }
    projectId = project.id
    const doc = (await (
      await page.request.post('/api/documents', {
        data: { title: `Planting plan ${name}`, folder: project.slug, content: `# Planting plan ${name}\n\nTomatoes go by the **south wall**.\n` },
      })
    ).json()) as { id: string }
    documentId = doc.id
    // Long notes with a wide table and a long word, and a link to the document.
    const notes = [
      `Ask for the **heirloom** ones, see [the plan](/documents/${doc.id}).`,
      '| Variety | Sow | Plant out | Harvest | Notes |\n|---|---|---|---|---|\n| San Marzano | March | May | August | needs the warmest bed by the wall |',
      `https://example.com/${'a-very-long-address-'.repeat(8)}`,
      ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the notes, with enough words to fill more than one line on a phone.`),
      'The last line of the notes.',
    ].join('\n\n')
    await page.request.post('/api/tasks', { data: { title: `Buy seeds ${name}`, project_id: project.id, description: notes } })
    await page.request.post('/api/tasks', { data: { title: `Dig beds ${name}`, project_id: project.id } })

    // The document by itself, from its own menu.
    await page.goto(`/documents/${doc.id}`)
    await page.getByRole('main').getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const documentUrl = await dialog.getByLabel('Link', { exact: true }).inputValue()
    await visitor.goto(documentUrl)
    await expect(visitor.getByRole('heading', { name: `Planting plan ${name}` })).toHaveCount(1) // not repeated by the text
    await expect(visitor.getByText('Tomatoes go by the south wall.')).toBeVisible()
    await page.keyboard.press('Escape')

    // The project: tasks and documents, no chats to choose.
    await page.goto('/projects')
    await page.getByRole('button', { name: `Actions for ${name}` }).click()
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByRole('checkbox')).toHaveCount(3)
    await expect(dialog.getByRole('checkbox', { name: /Chats/ })).toHaveCount(0)
    await dialog.getByRole('checkbox', { name: /Upcoming events/ }).uncheck()
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const projectUrl = await dialog.getByLabel('Link', { exact: true }).inputValue()

    await visitor.goto(projectUrl)
    await expect(visitor.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(visitor.getByText(`Buy seeds ${name}`)).toBeVisible()
    await expect(visitor.getByRole('heading', { name: 'Upcoming events' })).toHaveCount(0)
    await expect(visitor.getByText('never shown')).toHaveCount(0)
    const fitsTheScreen = () => visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    // A task without notes is just a line; one with notes opens on its own page, where
    // long notes have the whole width and the page still fits a phone.
    await expect(visitor.getByRole('link', { name: `Dig beds ${name}` })).toHaveCount(0)
    await visitor.getByRole('link', { name: `Buy seeds ${name}` }).click()
    await expect(visitor).toHaveURL(/\?task=0$/)
    await expect(visitor.getByRole('heading', { name: `Buy seeds ${name}` })).toBeVisible()
    await expect(visitor.getByText('To do ·')).toBeVisible()
    await expect(visitor.getByRole('cell', { name: 'San Marzano' })).toBeVisible()
    await expect(visitor.getByText('The last line of the notes.')).toBeAttached()
    expect(await fitsTheScreen()).toBe(true)
    // The link in the notes leads to the document inside the same copy, and back.
    await visitor.getByRole('link', { name: 'the plan' }).click()
    await expect(visitor).toHaveURL(/\?doc=0$/)
    await expect(visitor.getByText('Tomatoes go by the south wall.')).toBeVisible()
    await visitor.getByRole('link', { name, exact: true }).click()
    await expect(visitor.getByRole('link', { name: `Buy seeds ${name}` })).toBeVisible()
    // Open the document from the project, read it, and go back.
    await visitor.getByRole('link', { name: `Planting plan ${name}` }).click()
    await expect(visitor).toHaveURL(/\?doc=0$/)
    await expect(visitor.getByText('Tomatoes go by the south wall.')).toBeVisible()
    expect(await fitsTheScreen()).toBe(true)
    await visitor.getByRole('link', { name, exact: true }).click()
    await expect(visitor.getByText(`Buy seeds ${name}`)).toBeVisible()
    await visitor.reload() // the address of a document also works when opened directly
    await visitor.goto(`${projectUrl}?doc=0`)
    await expect(visitor.getByText('Tomatoes go by the south wall.')).toBeVisible()
  } finally {
    await context.close()
    if (documentId) await page.request.delete(`/api/documents/${documentId}`)
    const tasks = (await (await page.request.get('/api/tasks')).json()) as { id: string; title: string }[]
    for (const t of tasks.filter((x) => x.title.includes(name))) await page.request.delete(`/api/tasks/${t.id}`)
    if (projectId) await page.request.delete(`/api/projects/${projectId}`)
  }
})
