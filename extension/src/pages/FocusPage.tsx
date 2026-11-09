/**
 * The focus page: shown instead of a site on the distraction list while a focus phase
 * runs (feature 10). The time left and the task come from Anemo's shared timer. There is
 * no way past it but stopping focus; when the phase ends, it offers the way back.
 */
import { useEffect, useState } from 'react'
import { createApi, unwrap } from '@/shared/api'
import { blockingUntil, timer, type FocusMirror } from '@/shared/focus'
import { storage } from '@/shared/storage'
import { applyAccent } from '../panel/theme'

/** The blocked address (after `#`, put there by the blocking rule); only http(s). */
function blockedUrl(): URL | null {
  try {
    const url = new URL(decodeURIComponent(location.hash.slice(1)))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function useMirror(): FocusMirror | null | undefined {
  const [mirror, setMirror] = useState<FocusMirror | null | undefined>(undefined)
  useEffect(() => {
    void storage.get('local', 'focusTimer').then((m) => setMirror(m ?? null))
    return storage.watch('local', 'focusTimer', (m) => setMirror(m ?? null))
  }, [])
  return mirror
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/** The title of the task focus is on (read from Anemo; nothing when offline). */
function useTaskTitle(taskId: string | null | undefined): string | null {
  const [title, setTitle] = useState<{ id: string; title: string } | null>(null)
  useEffect(() => {
    if (!taskId) return
    let gone = false
    void (async () => {
      const connection = await storage.get('local', 'connection')
      if (!connection?.token) return
      const api = createApi({ serverUrl: connection.serverUrl, token: connection.token })
      const tasks = unwrap(await api.GET('/api/tasks', { params: { query: { status: 'all' } } }))
      const task = tasks.find((t) => t.id === taskId)
      if (!gone && task) setTitle({ id: task.id, title: task.title })
    })().catch(() => undefined)
    return () => {
      gone = true
    }
  }, [taskId])
  return title && title.id === taskId ? title.title : null
}

export function FocusPage() {
  const mirror = useMirror()
  const now = useNow()
  const site = blockedUrl()
  const until = blockingUntil(mirror, now)
  const task = useTaskTitle(mirror?.state?.taskId)
  useEffect(() => {
    void storage.get('local', 'accent').then(applyAccent)
  }, [])
  useEffect(() => {
    document.title = until !== null ? `Focus · ${timer.formatClock(until - now)}` : 'Focus is over'
  }, [until, now])

  if (mirror === undefined) return null
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <img src="/icons/icon-48.png" alt="" className="h-12 w-12 rounded-xl" />
        {until !== null ? (
          <>
            <h1 className="text-[20px] font-semibold">{site ? `${site.hostname.replace(/^www\./, '')} is blocked while you focus` : 'Blocked while you focus'}</h1>
            <div className="font-mono text-[56px] font-semibold tabular-nums leading-none text-accent" aria-label="Focus time left" data-testid="focus-left">
              {timer.formatClock(until - now)}
            </div>
            {task ? <p className="text-[14px] text-muted">You’re working on “{task}”.</p> : <p className="text-[14px] text-muted">Back to it: the break comes soon.</p>}
            <p className="text-[12.5px] text-subtle">To get here before the break, stop focus in Anemo or in the extension’s Focus tab.</p>
          </>
        ) : (
          <>
            <h1 className="text-[20px] font-semibold">Focus is over</h1>
            <p className="text-[14px] text-muted">Nothing is blocked now.</p>
            {site && (
              <a className="rounded-control bg-accent px-4 py-2 text-[14px] font-medium text-accent-contrast hover:bg-accent-hover" href={site.href}>
                Go to {site.hostname.replace(/^www\./, '')}
              </a>
            )}
          </>
        )}
      </div>
    </main>
  )
}
