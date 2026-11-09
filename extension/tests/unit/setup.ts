/**
 * A small in-memory stand-in for the `chrome` APIs the code under test touches. Each test
 * file gets a fresh one (vitest isolates files); `resetChrome()` clears it between tests.
 */
import '@testing-library/jest-dom/vitest'
import { beforeEach, vi } from 'vitest'

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void

function area(name: string, listeners: Set<Listener>) {
  let data: Record<string, unknown> = {}
  return {
    get: vi.fn(async (key?: string | string[] | null) => {
      if (key == null) return { ...data }
      const keys = Array.isArray(key) ? key : [key]
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]))
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, chrome.storage.StorageChange> = {}
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) }
        data[k] = structuredClone(v)
      }
      for (const l of listeners) l(changes, name)
    }),
    remove: vi.fn(async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k]
    }),
    clear: () => {
      data = {}
    },
  }
}

export function makeChrome() {
  const listeners = new Set<Listener>()
  const granted = new Set<string>()
  const local = area('local', listeners)
  const session = area('session', listeners)
  return {
    runtime: {
      id: 'jpmimgldkledmklijfmfnbaaimmfjaaf',
      getURL: (p: string) => `chrome-extension://jpmimgldkledmklijfmfnbaaimmfjaaf/${p}`,
      getManifest: () => ({ version: '0.0.0-test' }),
      sendMessage: vi.fn(async () => ({ ok: true })),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local,
      session,
      onChanged: { addListener: (l: Listener) => listeners.add(l), removeListener: (l: Listener) => listeners.delete(l) },
    },
    permissions: {
      granted,
      contains: vi.fn(async (p: chrome.permissions.Permissions) => [...(p.origins ?? []), ...(p.permissions ?? [])].every((x) => granted.has(x))),
      request: vi.fn(async (p: chrome.permissions.Permissions) => {
        for (const x of [...(p.origins ?? []), ...(p.permissions ?? [])]) granted.add(x)
        return true
      }),
      remove: vi.fn(async (p: chrome.permissions.Permissions) => {
        for (const x of [...(p.origins ?? []), ...(p.permissions ?? [])]) granted.delete(x)
        return true
      }),
    },
    reset() {
      local.clear()
      session.clear()
      granted.clear()
    },
  }
}

const fake = makeChrome()
;(globalThis as unknown as { chrome: unknown }).chrome = fake

export function resetChrome(): void {
  fake.reset()
}

beforeEach(() => resetChrome())
