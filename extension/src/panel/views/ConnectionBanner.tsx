import { useCallback, useEffect, useState } from 'react'
import { ApiError, unwrap, type Api } from '@/shared/api'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { helpFor } from '../lib/help'

const RECHECK_MS = 60_000

/**
 * Checks that Anemo answers when the panel opens, when the network comes back, and every
 * minute while something is wrong; says what is wrong. A 401 needs no banner: it sends
 * the panel back to setup by itself.
 */
export function ConnectionBanner({ api }: { api: Api }) {
  const [problem, setProblem] = useState<ApiError | null>(null)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    try {
      unwrap(await api.GET('/api/auth/me'))
      setProblem(null)
    } catch (err) {
      setProblem(err instanceof ApiError && err.kind !== 'unauthorized' ? err : null)
    }
  }, [api])

  const retry = async () => {
    setChecking(true)
    await check()
    setChecking(false)
  }

  useEffect(() => {
    const first = window.setTimeout(() => void check(), 0)
    const online = () => void check()
    window.addEventListener('online', online)
    window.addEventListener('offline', online)
    return () => {
      window.clearTimeout(first)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', online)
    }
  }, [check])

  useEffect(() => {
    if (!problem) return
    const timer = window.setInterval(() => void check(), RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [problem, check])

  if (!problem) return null
  const help = helpFor('server', problem, chrome.runtime.id)
  return (
    <div className="px-3 pt-3">
      <Notice
        tone={problem.kind === 'offline' ? 'offline' : 'error'}
        title={help.title}
        actions={<Button size="sm" loading={checking} onClick={() => void retry()}>Try again</Button>}
      >
        {help.body}
      </Notice>
    </div>
  )
}
