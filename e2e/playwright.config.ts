import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against a running stack (docker compose up) with the fake
 * provider enabled (ENABLE_FAKE_PROVIDER=true). Credentials come from env:
 *
 *   E2E_BASE_URL=http://localhost:8080 E2E_USERNAME=admin E2E_PASSWORD=... npm test
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/mobile\.spec\.ts/, /automations\.spec\.ts/, /pages-and-language\.spec\.ts/],
    },
    // Phone size with touch (pointer: coarse), Chromium-based so no extra browser is needed.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
    // Runs after the others, with nothing beside it: it switches the app's language and
    // turns pages off for everyone, so a test logging in at the same time on the other
    // worker would see Ukrainian menus or a page missing.
    {
      name: 'app-wide',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /pages-and-language\.spec\.ts/,
      dependencies: ['desktop', 'mobile'],
    },
    // Runs last: its notification pops up in every open tab of the app,
    // where it could get in the way of another test's clicks.
    {
      name: 'notifications',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /automations\.spec\.ts/,
      dependencies: ['app-wide'],
    },
  ],
})
