import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Outlet, useLocation } from 'react-router'
import { CloudOff } from 'lucide-react'
import { errorMessage, onUnauthorized } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { t } from '@/lib/i18n'
import { meKey, useMe } from './api'

/** Layout route: renders children only for a logged-in user, otherwise redirects to /login. */
export function RequireAuth() {
  const me = useMe()
  const location = useLocation()
  const qc = useQueryClient()

  // Any API call that returns 401 (e.g. session expired) logs the UI out.
  useEffect(() => onUnauthorized(() => qc.setQueryData(meKey, null)), [qc])

  // Couldn't ask the server at all: try again as soon as the device is back online.
  const unreachable = me.isError && !me.data
  useEffect(() => {
    if (!unreachable) return
    const retry = () => void me.refetch()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [unreachable, me])

  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    )
  }
  // Only "not logged in" leads to the login page. A server error or no connection (e.g.
  // the installed app opened offline) says so instead, and keeps you where you were.
  if (unreachable) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={<CloudOff className="h-6 w-6" />} title={t('Can’t reach Anemo')}
          description={t('{reason} This page tries again when the connection is back.', { reason: navigator.onLine ? errorMessage(me.error) : t('You’re offline.') })}
          action={<Button onClick={() => void me.refetch()} disabled={me.isFetching}>{me.isFetching ? t('Trying…') : t('Try again')}</Button>} />
      </div>
    )
  }
  if (!me.data) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <Outlet />
}
