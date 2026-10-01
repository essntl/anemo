import { useRouteError } from 'react-router'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'

/**
 * Shown when a page fails to load or crashes while rendering. The usual cause is
 * harmless: the app was updated while this tab was open, so the page's code has
 * a new address. Reloading fetches the current version.
 */
export function RouteError() {
  const error = useRouteError()
  const detail = error instanceof Error ? error.message : ''
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">This page could not be shown</h1>
      <p className="max-w-sm text-[13px] text-muted">
        If the app was just updated, reloading fixes it. Your data is not affected.
      </p>
      <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => window.location.reload()}>
        Reload
      </Button>
      {detail && <p className="max-w-md break-words font-mono text-[11.5px] text-subtle">{detail}</p>}
    </div>
  )
}
