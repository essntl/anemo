import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@playwright/test'

/*
 * A lock shared by the Playwright workers (separate processes on one machine).
 *
 * Anemo has one user, so a few things exist once on the server: the focus timer, the
 * Home layout. Tests that use one of them take its lock, and the others wait, so any
 * number of workers can run. The lock is a folder (mkdir either creates it or fails,
 * atomically) holding the owner's process id; a lock whose owner died is taken over.
 */

const ROOT = join(tmpdir(), 'anemo-e2e-locks')
const held = new Set<string>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** True when the lock folder is left over from a worker that is gone. */
function stale(dir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    return !alive(pid)
  } catch {
    // No pid file yet: its owner is between mkdir and writing it, unless that was long ago.
    try {
      return Date.now() - statSync(dir).mtimeMs > 60_000
    } catch {
      return false // just released
    }
  }
}

/**
 * Waits for the named lock and holds it until the end of the test (`releaseAppLocks`,
 * called by `signOutAfterEach`). The time spent waiting is added to the test's timeout.
 * Take at most one lock per test, so two tests can never wait for each other.
 */
export async function appLock(name: string): Promise<void> {
  if (held.has(name)) return
  const dir = join(ROOT, name)
  mkdirSync(ROOT, { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'pid'), String(process.pid))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (stale(dir)) rmSync(dir, { recursive: true, force: true })
      else await new Promise((r) => setTimeout(r, 100))
    }
  }
  held.add(name)
  const waited = Date.now() - start
  if (waited > 0) test.info().setTimeout(test.info().timeout + waited)
}

/** Releases every lock this worker holds (after each test). */
export function releaseAppLocks(): void {
  for (const name of held) rmSync(join(ROOT, name), { recursive: true, force: true })
  held.clear()
}
