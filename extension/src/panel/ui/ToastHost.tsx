import { X } from 'lucide-react'
import { cn } from '../lib/cn'
import { dismissToast, useToast } from './toast'

export function ToastHost() {
  const t = useToast()
  if (!t) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-[60] flex justify-center px-3">
      <div key={t.id} role="status" className={cn('pop pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-card py-1.5 pl-4 pr-1.5 text-[12.5px] shadow-float', t.tone === 'error' ? 'border-error/40 text-error' : 'border-border')}>
        <span className="truncate">{t.message}</span>
        {t.action && (
          <button
            type="button"
            className="shrink-0 rounded-full px-2.5 py-1 font-semibold text-accent hover:bg-accent-soft"
            onClick={() => {
              t.action!.run()
              dismissToast()
            }}
          >
            {t.action.label}
          </button>
        )}
        <button type="button" aria-label="Dismiss" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text" onClick={dismissToast}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
