import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'

/** How long a load may take before it says so: most are done sooner, and a "Loading…"
 * that shows for a frame and is replaced reads as a blink. */
export const LOADING_DELAY_MS = 300

/** "Loading…", shown only once loading has taken LOADING_DELAY_MS. */
export function DelayedLoading({ className }: { className?: string }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADING_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  if (!shown) return null
  return <p className={cn('text-muted swap-in', className)}>{t('Loading…')}</p>
}
