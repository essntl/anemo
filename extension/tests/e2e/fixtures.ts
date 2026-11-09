/** Launches Chromium with the built extension (dist-e2e/) and a mock Anemo server. */
import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EXTENSION_ID, startMockAnemo, type MockAnemo } from './mockAnemo'

const DIST = resolve(import.meta.dirname, '../../dist-e2e')

export const test = base.extend<{ context: BrowserContext; extensionId: string; anemo: MockAnemo; panel: Page }>({
  // oxlint-disable-next-line no-empty-pattern
  context: async ({}, provide) => {
    const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'anemo-ext-')), {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--autoplay-policy=no-user-gesture-required'],
    })
    await provide(context)
    await context.close()
  },
  extensionId: async ({ context }, provide) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    await provide(new URL(worker.url()).host)
  },
  // oxlint-disable-next-line no-empty-pattern
  anemo: async ({}, provide) => {
    const anemo = await startMockAnemo()
    await provide(anemo)
    await anemo.close()
  },
  panel: async ({ context, extensionId }, provide) => {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/panel/index.html`)
    await provide(page)
  },
})

export { EXTENSION_ID }
export const expect = test.expect

/** Picks an option of one of the panel's dropdowns (styled, not the browser's <select>). */
export async function choose(page: Page, label: string, option: string | RegExp): Promise<void> {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option }).click()
}
