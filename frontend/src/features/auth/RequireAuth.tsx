import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Outlet, useLocation } from 'react-router'
import { onUnauthorized } from '@/api/client'
import { meKey, useMe } from './api'

/** Layout route: renders children only for a logged-in user, otherwise redirects to /login. */
export function RequireAuth() {
  const me = useMe()
  const location = useLocation()
  const qc = useQueryClient()

  // Any API call that returns 401 (e.g. session expired) logs the UI out.
  useEffect(() => onUnauthorized(() => qc.setQueryData(meKey, null)), [qc])

  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    )
  }
  if (!me.data) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <Outlet />
}
