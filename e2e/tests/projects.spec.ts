import { expect, type Page, test } from '@playwright/test'
import { confirmWith, fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * Projects, organising chats, and referencing / editing / branching / saving a chat.
 * Everything created has a unique name and is removed again through the API, also
 * when a test fails. Tests that create a project (which makes folders in the
 * workspace) or need a model only run with the fake provider, i.e. on a test install.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

async function createChat(page: Page, body: Record<string, unknown>): Promise<string> {
  const r = await page.request.post('/api/conversations', { data: body })
  return ((await r.json()) as { id: string }).id
}

async function deleteChats(page: Page, mark: string) {
  for (const archived of [false, true]) {
    const r = await page.request.get(`/api/conversations?limit=500&archived=${archived}`)
    const chats = (await r.json()) as { id: string; title: string }[]
    for (const c of chats.filter((x) => x.title.includes(mark))) await page.request.delete(`/api/conversations/${c.id}`)
  }
}

test('the all-chats overview filters, sorts and changes several chats at once', async ({ page }) => {
  const mark = `ovw${suffix()}`
  await login(page)
  try {
    for (const name of ['Banana', 'apple', 'Cherry']) await createChat(page, { title: `${name} ${mark}` })
    await page.goto(`/chats?q=${mark}`)
    // The same chats are also in the sidebar: look at the page itself.
    const rows = page.getByRole('main').getByRole('link', { name: new RegExp(mark) })
    await expect(rows).toHaveCount(3)

    // Sorted by title, whatever the case.
    await page.getByRole('combobox', { name: 'Sort by' }).click()
    await page.getByRole('option', { name: 'Title A–Z' }).click()
    await expect(page).toHaveURL(/sort=title/)
    await expect(rows.first()).toContainText('apple')
    await expect(rows.last()).toContainText('Cherry')

    // Filter by when a chat was last active: these are from today, none are older.
    await page.getByRole('combobox', { name: 'Last active' }).click()
    await page.getByRole('option', { name: 'Older' }).click()
    await expect(rows).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Last active' }).click()
    await page.getByRole('option', { name: 'Today' }).click()
    await expect(page).toHaveURL(/age=today/)
    await expect(rows).toHaveCount(3)

    // The Favorite button undoes itself: with only favorites selected it says Unfavorite.
    const toolbar = page.getByRole('toolbar', { name: 'Actions for the selected chats' })
    const apple = page.getByRole('checkbox', { name: `Select apple ${mark}` })
    await apple.check()
    await toolbar.getByRole('button', { name: 'Favorite', exact: true }).click()
    await expect(rows.first().getByLabel('Favorite')).toBeVisible()
    // The selection stays after an action, so the next one applies to the same chats.
    await expect(apple).toBeChecked()
    await toolbar.getByRole('button', { name: 'Unfavorite' }).click()
    await expect(rows.first().getByLabel('Favorite')).toHaveCount(0)
    // "Clear selection" lets go of it.
    await page.getByRole('button', { name: 'Clear selection' }).click()
    await expect(apple).not.toBeChecked()
    await expect(toolbar.getByRole('button', { name: 'Archive' })).toBeDisabled()

    // Select two and archive them: they leave the list and show under "Archived".
    await page.getByRole('checkbox', { name: `Select apple ${mark}` }).check()
    await page.getByRole('checkbox', { name: `Select Banana ${mark}` }).check()
    await toolbar.getByRole('button', { name: 'Archive' }).click()
    await expect(rows).toHaveCount(1)
    await page.getByRole('combobox', { name: 'Show' }).click()
    await page.getByRole('option', { name: 'Archived' }).click()
    await expect(rows).toHaveCount(2)

    // Tag everything shown, then delete it after a confirmation.
    await page.getByRole('checkbox', { name: 'Select all shown' }).check()
    await toolbar.getByRole('button', { name: 'Tag' }).click()
    await page.getByRole('dialog').getByRole('textbox').fill('Fruit')
    await page.getByRole('dialog').getByRole('button', { name: 'Add tag' }).click()
    await expect(rows.first()).toContainText('#fruit')
    await page.getByRole('checkbox', { name: 'Select all shown' }).check()
    await toolbar.getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Delete')
    await expect(rows).toHaveCount(0)
  } finally {
    await deleteChats(page, mark)
  }
})

test('the pages are pinned under the chats, which are the only thing that scrolls', async ({ page }) => {
  await login(page)
  const sidebar = page.locator('aside').first()
  const pages = sidebar.getByRole('navigation', { name: 'Pages' })
  await expect(pages.getByRole('link')).toHaveCount(9)
  await expect(pages.getByRole('link', { name: 'Files', exact: true })).toBeVisible()
  // The chat list takes the free height and scrolls by itself; the column around it does not.
  const list = sidebar.getByLabel('Chats', { exact: true })
  expect(await list.evaluate((el) => [getComputedStyle(el).flexGrow, getComputedStyle(el).overflowY])).toEqual(['1', 'auto'])
  expect(await sidebar.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  // Short names in the grid; the full one is the tooltip.
  await expect(pages.getByRole('link', { name: 'Agents' })).toHaveAttribute('title', 'Profiles & Skills')
})

test('a project narrows the chat list, and new chats start in it', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request) // skips without the fake provider
  const name = `Proj ${suffix()}`
  let projectId = ''
  try {
    // Create it through the page.
    await page.goto('/projects')
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByLabel('Instructions for the assistant').fill('Always answer in haiku.')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const projects = (await (await page.request.get('/api/projects')).json()) as { id: string; name: string }[]
    projectId = projects.find((p) => p.name === name)!.id

    const inside = `inside ${name}`
    const outside = `outside ${name}`
    await createChat(page, { title: inside, project_id: projectId })
    await createChat(page, { title: outside })

    // Choose the project in the sidebar: only its chats are listed.
    const sidebar = page.locator('aside').first()
    await sidebar.getByRole('combobox', { name: 'Project' }).click()
    await page.getByRole('option', { name }).click()
    const chats = sidebar.getByLabel('Chats', { exact: true })
    await expect(chats.getByRole('link', { name: inside })).toBeVisible()
    await expect(chats.getByRole('link', { name: outside })).toHaveCount(0)

    // A chat started now belongs to the project.
    await newChat(page, 'Chat', models.echo)
    await expect(page.getByText(`New chat in ${name}`)).toBeVisible()
    await send(page, `hello ${name}`)
    await expect(page).toHaveURL(/\/c\//)
    await expect(page.getByText(`You said: hello ${name}`)).toBeVisible()
    const id = page.url().split('/c/')[1]
    const chat = (await (await page.request.get(`/api/conversations/${id}`)).json()) as { project_id: string }
    expect(chat.project_id).toBe(projectId)

    // Back to everything.
    await sidebar.getByRole('combobox', { name: 'Project' }).click()
    await page.getByRole('option', { name: 'All projects' }).click()
    await expect(chats.getByRole('link', { name: outside })).toBeVisible()
  } finally {
    await deleteChats(page, name)
    if (projectId) await page.request.delete(`/api/projects/${projectId}`)
  }
})

test('reference a chat, edit the last message, branch, and save as a document', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request) // skips without the fake provider
  const mark = `ref${suffix()}`
  let documentId = ''
  try {
    // A chat to refer to.
    await newChat(page, 'Chat', models.echo)
    await send(page, `The secret word is pineapple ${mark}`)
    await expect(page.getByText(`You said: The secret word is pineapple ${mark}`)).toBeVisible()
    const earlier = page.url().split('/c/')[1]
    await page.request.patch(`/api/conversations/${earlier}`, { data: { title: `Earlier ${mark}` } })

    // A new chat that references it: the model receives the earlier chat's text.
    await newChat(page, 'Chat', models.echo)
    await page.getByRole('button', { name: 'Reference a chat' }).click()
    const picker = page.getByRole('dialog')
    await picker.getByLabel('Search your chats').fill(mark)
    await picker.getByRole('button', { name: new RegExp(`Earlier ${mark}`) }).click()
    await expect(picker).toHaveCount(0)
    await expect(page.getByTitle(`Referenced chat: Earlier ${mark}`)).toBeVisible()
    await send(page, `What was the word? ${mark}`)
    await expect(page).toHaveURL(/\/c\//)
    const answer = page.getByText(/You said:/).last()
    await expect(answer).toContainText('referenced_chat')
    await expect(answer).toContainText('pineapple')
    await expect(page.getByRole('link', { name: `Earlier ${mark}` }).last()).toBeVisible()
    await page.request.patch(`/api/conversations/${page.url().split('/c/')[1]}`, { data: { title: `Asking ${mark}` } })

    // Edit the message and send it again: the answer is replaced.
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Edit your message').fill(`Tell me the fruit ${mark}`)
    await page.getByRole('button', { name: 'Send again' }).click()
    await expect(page.getByText(/You said:/).last()).toContainText(`Tell me the fruit ${mark}`)
    await expect(page.getByText(`What was the word? ${mark}`)).toHaveCount(0)

    // Branch from the answer: a new chat with the same messages.
    const original = page.url()
    await page.getByRole('button', { name: 'Branch' }).last().click()
    await expect(page).not.toHaveURL(original)
    await expect(page.getByText('Branched from another chat')).toBeVisible()
    await expect(page.getByText(`Tell me the fruit ${mark}`).first()).toBeVisible()

    // Save the branch as a document.
    await page.getByRole('button', { name: 'Chat actions' }).click()
    await page.getByRole('button', { name: 'Save as document' }).click()
    await expect(page.getByText(/Saved as documents\//)).toBeVisible()
    const docs = (await (await page.request.get('/api/documents')).json()) as { documents: { id: string; title: string }[] }
    documentId = docs.documents.find((d) => d.title.includes(mark))!.id
    await page.goto(`/documents/${documentId}`)
    await expect(page.getByText(`Tell me the fruit ${mark}`).first()).toBeVisible()
  } finally {
    if (documentId) await page.request.delete(`/api/documents/${documentId}`)
    await deleteChats(page, mark)
  }
})
