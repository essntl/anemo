import { expect, type APIRequestContext, type Page, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Moving things around without typing paths: cut / copy / paste in the file manager,
 * and putting files and documents into a project. Everything made here is removed
 * afterwards (trash emptied of it, project deleted).
 */

signOutAfterEach()

const mark = () => Math.random().toString(36).slice(2, 8)

async function writeFile(request: APIRequestContext, path: string, content = 'hello') {
  const r = await request.put('/api/files/content', { data: { path, content, base_hash: null } })
  expect(r.ok()).toBe(true)
}

/** Trash these paths (if still there) and empty them out of the trash. */
async function cleanUp(request: APIRequestContext, paths: string[]) {
  for (const path of paths) await request.post('/api/files/trash', { data: { path } })
  const trash = (await (await request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
  for (const item of trash.filter((t) => paths.some((p) => t.original_path === p || t.original_path.startsWith(`${p}/`)))) {
    await request.delete(`/api/files/trash/${item.id}`)
  }
}

const row = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function rowAction(page: Page, name: string, action: string) {
  await row(page, name).hover()
  await row(page, name).locator('..').getByRole('button', { name: action, exact: true }).click()
}

test('cut, copy and paste in the file manager', async ({ page }) => {
  await login(page)
  const base = `e2e-files-${mark()}`
  try {
    await writeFile(page.request, `${base}/a/report.txt`)
    await page.request.post('/api/files/folder', { data: { path: `${base}/b` } })

    // Copy into b: the original stays. (Folders are opened by clicking, as a person
    // would: the clipboard lives in the open tab.)
    await page.goto(`/files?path=${base}`)
    const up = () => page.getByRole('button', { name: base, exact: true }).click()
    await row(page, 'a').click()
    await rowAction(page, 'report.txt', 'Copy')
    await expect(page.getByRole('status').filter({ hasText: 'report.txt copied' })).toBeVisible()
    await up()
    await row(page, 'b').click()
    await page.getByRole('button', { name: 'Paste here' }).click()
    await expect(row(page, 'report.txt')).toBeVisible()

    // Cut from a, paste into b where the name is taken: both are kept.
    await up()
    await row(page, 'a').click()
    await rowAction(page, 'report.txt', 'Cut')
    // Pasting where it already is does nothing.
    await expect(page.getByRole('button', { name: 'Paste here' })).toBeDisabled()
    await up()
    await row(page, 'b').click()
    await page.getByRole('button', { name: 'Paste here' }).click()
    await expect(row(page, 'report (1).txt')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Paste here' })).toHaveCount(0) // a cut is pasted once
    const a = (await (await page.request.get('/api/files', { params: { path: `${base}/a` } })).json()) as { entries: unknown[] }
    expect(a.entries).toHaveLength(0)

    // A folder can't go into itself.
    await up()
    await rowAction(page, 'b', 'Cut')
    await row(page, 'b').click()
    await expect(page.getByRole('button', { name: 'Paste here' })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('button', { name: 'Paste here' })).toHaveCount(0)
  } finally {
    await cleanUp(page.request, [base])
  }
})

test('files and documents go into a project without typing a path', async ({ page }) => {
  await login(page)
  const name = `E2E project ${mark()}`
  const project = (await (await page.request.post('/api/projects', { data: { name } })).json()) as {
    id: string
    files_path: string
    documents_path: string
  }
  const base = `e2e-files-${mark()}`
  let docId = ''
  try {
    // A file: into the project's files.
    await writeFile(page.request, `${base}/plan.txt`)
    await page.goto(`/files?path=${base}`)
    await rowAction(page, 'plan.txt', 'Move to a project')
    await page.getByRole('dialog').getByRole('option', { name: new RegExp(name) }).click()
    await expect(page.getByText(`Moved to ${name}.`)).toBeVisible()
    const inProject = (await (await page.request.get('/api/files', { params: { path: project.files_path } })).json()) as { entries: { name: string }[] }
    expect(inProject.entries.map((e) => e.name)).toContain('plan.txt')

    // A document: from its editor, into the project, keeping its history.
    const doc = (await (await page.request.post('/api/documents', { data: { title: `Notes ${mark()}`, folder: '', content: null } })).json()) as { id: string }
    docId = doc.id
    await page.goto(`/documents/${doc.id}`)
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Move to project or folder' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('option', { name: /Documents.*Here now/ })).toBeDisabled()
    await dialog.getByRole('option', { name: new RegExp(name) }).click()
    await expect(page.getByText(`Moved to ${name}.`)).toBeVisible()
    const moved = (await (await page.request.get(`/api/documents/${doc.id}`)).json()) as { path: string }
    expect(moved.path.startsWith(`${project.documents_path}/`)).toBe(true)
  } finally {
    if (docId) await page.request.delete(`/api/documents/${docId}`)
    await page.request.delete(`/api/projects/${project.id}`)
    await cleanUp(page.request, [base, project.files_path, project.documents_path])
  }
})
