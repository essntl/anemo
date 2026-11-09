import type { Page, Worker } from '@playwright/test'
import { expect, test } from './fixtures'
import { addChat } from './mockChat'
import { addInline } from './mockInline'

let inline: ReturnType<typeof addInline>
let article: Page
let worker: Worker

/** What a right-click on the article would do (tests can't open Chrome's context menu). */
async function rightClick(menuItemId: string, selectionText = '') {
  await worker.evaluate(
    async ({ menuItemId, selectionText }) => {
      const [tab] = await chrome.tabs.query({ active: true, windowType: 'normal' })
      ;(globalThis as unknown as { __anemoTest: { onInlineClick: (id: string, info: unknown, tab: unknown) => void } }).__anemoTest.onInlineClick(
        menuItemId,
        { menuItemId, frameId: 0, selectionText, pageUrl: tab.url, frameUrl: tab.url, editable: false },
        tab,
      )
    },
    { menuItemId, selectionText },
  )
}

async function select(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    const range = document.createRange()
    range.selectNodeContents(el)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  }, selector)
}

const box = () => article.locator('anemo-companion .box')

test.beforeEach(async ({ panel, anemo, context }) => {
  addChat(anemo)
  inline = addInline(anemo)
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  worker = context.serviceWorkers()[0]
  article = await context.newPage()
  await article.goto(`${anemo.url}/article`)
  await article.bringToFront()
})

test('Explain shows a streamed explanation in a box next to the selection', async () => {
  await select(article, 'article p:nth-of-type(1) strong')
  await rightClick('anemo-explain', 'light')
  await expect(box()).toContainText('Photosynthesis is how plants make sugar from light.')
  await expect(box().locator('table')).toContainText('foto')
  await expect(box().getByRole('button', { name: 'Save to Anemo' })).toBeVisible()
  const sent = inline.requests.find((r) => r.path === 'explain')!.body
  expect(sent).toMatchObject({ text: 'light', target_language: 'en', breakdown: true })
  expect(String(sent.context)).toContain('plants turn light into chemical energy')
  // Esc closes it.
  await article.keyboard.press('Escape')
  await expect(box()).toHaveCount(0)
})

test('Translate replaces the selection in place, keeps the markup, and restores', async ({ panel }) => {
  const p = article.locator('article p').nth(1)
  const before = await p.innerHTML()
  await select(article, 'article p:nth-of-type(2)')
  await rightClick('anemo-translate:de')
  await expect(p).toContainText('PLANTS TURN LIGHT INTO CHEMICAL ENERGY')
  // The <strong> is still there, around its own (translated) word.
  await expect(p.locator('strong')).toHaveText('LIGHT')
  expect(inline.requests.find((r) => r.path === 'translate')!.body).toMatchObject({ target_language: 'de' })
  expect(String(inline.requests.find((r) => r.path === 'translate')!.body.text)).toMatch(/^<1>Paragraph 1: plants turn <\/1><2>light<\/2><3>/)
  // Restore all from the panel's Capture view.
  await panel.getByRole('button', { name: 'Capture' }).click()
  await panel.getByTestId('restore-translations').getByRole('button', { name: 'Restore all' }).click()
  await expect.poll(() => p.innerHTML()).toBe(before)
})

test('the original shows in a readable box; once restored, the text shows nothing again', async () => {
  const p = article.locator('article p').nth(1)
  await select(article, 'article p:nth-of-type(2)')
  await rightClick('anemo-translate:de')
  await expect(p).toContainText('PLANTS TURN LIGHT')
  await article.evaluate(() => getSelection()!.removeAllRanges())
  await p.click({ position: { x: 20, y: 8 } })
  const pop = article.locator('anemo-companion .pop')
  await expect(pop).toContainText('Paragraph 1: plants turn light into chemical energy')
  // As wide as it says, not one word per line.
  expect((await pop.boundingBox())!.width).toBeGreaterThan(300)
  await pop.getByRole('button', { name: 'Restore original' }).click()
  await expect(p).toContainText('Paragraph 1: plants turn light')
  await expect(pop).toHaveCount(0)
  // The restored paragraph is the page's again: clicking or selecting it shows no box.
  await p.click({ position: { x: 20, y: 8 } })
  await select(article, 'article p:nth-of-type(2)')
  await article.mouse.move(30, 30)
  await p.hover({ position: { x: 40, y: 8 } })
  await article.waitForTimeout(700)
  await expect(pop).toHaveCount(0)
})

test('Translate page translates the content, not the menus', async () => {
  await rightClick('anemo-translate-page:en')
  await expect(article.locator('article p').last()).toContainText('LEARN MORE ON', { timeout: 15_000 })
  await expect(article.locator('nav')).toContainText('Home')
  await expect(article.locator('footer')).toContainText('Cookie settings')
  await expect(article.locator('article a[href="/wiki/Chlorophyll"]')).toHaveText('CHLOROPHYLL')
})

test('text in a field is shown translated in the box, never replaced', async () => {
  await article.evaluate(() => {
    const t = document.createElement('textarea')
    t.value = 'hei verden'
    document.body.prepend(t)
    t.focus()
    t.select()
  })
  await rightClick('anemo-translate:en', 'hei verden')
  await expect(box()).toContainText('HEI VERDEN')
  await expect(article.locator('textarea')).toHaveValue('hei verden')
})

test('Save to Anemo from the box opens the capture form with the selection and the explanation', async ({ panel }) => {
  await select(article, 'article p:nth-of-type(1) strong')
  await rightClick('anemo-explain', 'light')
  await box().getByRole('button', { name: 'Save to Anemo' }).click()
  await expect(panel.getByTestId('capture-source')).toContainText('With Anemo’s explanation underneath.')
  await expect(panel.getByRole('listbox', { name: 'Save to' }).getByRole('option', { name: /Inbox/ })).toHaveAttribute('aria-selected', 'true')
})
