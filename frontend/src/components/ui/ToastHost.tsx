import { X } from 'lucide-react'
import { useToasts } from './toast'

/** Shows the notices queued with toast(). Mounted once in AppLayout. */
export function ToastHost() {
  const { toasts, dismiss, remove } = useToasts()
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-3"
      role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} data-leaving={t.leaving || undefined}
          onAnimationEnd={(e) => t.leaving && e.target === e.currentTarget && remove(t.id)}
          className="toast pointer-events-auto flex max-w-[min(32rem,100%)] items-center gap-3 rounded-card border border-border bg-card py-2 pl-4 pr-2 text-[13px] shadow-float">
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          {t.action && (
            <button type="button" className="shrink-0 rounded-lg px-2 py-1 font-medium text-accent hover:bg-surface-hover"
              onClick={() => { t.action?.onClick(); dismiss(t.id) }}>
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
