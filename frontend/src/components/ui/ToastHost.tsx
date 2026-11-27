import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { plural, t } from '@/lib/i18n'
import { type ToastItem, type ToastLevel, useToasts, VISIBLE_TOASTS } from './toast'

const DEFAULT_DURATION = 6000
/** How far a notice is swiped sideways before it goes. */
const SWIPE_AWAY = 72

const LEVEL_ICON: Record<ToastLevel, ReactNode> = {
  info: <Info />,
  success: <CircleCheck />,
  warning: <TriangleAlert />,
  error: <CircleAlert />,
}
/** The level as an accent: the edge, the icon's tint and the time bar, never a full fill. */
const LEVEL_EDGE: Record<ToastLevel, string> = { info: 'bg-accent', success: 'bg-success', warning: 'bg-warning', error: 'bg-error' }
const LEVEL_TINT: Record<ToastLevel, string> = {
  info: 'bg-accent-soft text-accent',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  error: 'bg-error/12 text-error',
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const pageHidden = () => document.hidden

/** One notice: closes itself after its time (which waits while `paused`), or by a swipe. */
function Toast({ item, paused, onDismiss, onRemove }: {
  item: ToastItem
  paused: boolean
  onDismiss: () => void
  onRemove: () => void
}) {
  const duration = item.duration ?? DEFAULT_DURATION
  const remaining = useRef(duration)
  const [drag, setDrag] = useState<{ x0: number; dx: number } | null>(null)
  const [swiped, setSwiped] = useState(0)

  // The timer runs only while nothing holds it; the time left is kept across pauses.
  useEffect(() => {
    if (paused || item.leaving || drag) return
    const started = Date.now()
    const timer = window.setTimeout(onDismiss, remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [paused, item.leaving, drag, onDismiss])

  // Swipe sideways (touch or pen) to dismiss; a short drag springs back.
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x0: e.clientX, dx: 0 })
  }
  const move = (e: PointerEvent<HTMLDivElement>) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0 })
  const up = () => {
    if (!drag) return
    if (Math.abs(drag.dx) > SWIPE_AWAY) {
      setSwiped(Math.sign(drag.dx))
      onDismiss()
    }
    setDrag(null)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); onDismiss() }
  }

  const level = item.level
  const icon = item.icon ?? (level ? LEVEL_ICON[level] : null)
  const rich = Boolean(item.title || icon)
  const offset = drag ? drag.dx : swiped ? swiped * 120 : 0
  return (
    <div data-leaving={item.leaving || undefined} data-level={level}
      // Warnings and errors are read out at once; other notices when the reader is free.
      role={level === 'error' || level === 'warning' ? 'alert' : 'status'} aria-atomic="true"
      onAnimationEnd={(e) => item.leaving && e.target === e.currentTarget && onRemove()}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} onKeyDown={onKeyDown}
      style={offset ? { transform: `translateX(${offset}px)`, opacity: Math.max(0.2, 1 - Math.abs(offset) / 200) } : undefined}
      className={cn('toast pointer-events-auto relative w-full touch-pan-y overflow-hidden rounded-card border border-border bg-card text-[13px] shadow-float',
        !drag && 'transition-[transform,opacity] duration-150 motion-reduce:transition-none')}>
      {level && <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', LEVEL_EDGE[level])} />}
      <div className={cn('flex gap-3 pr-2', rich ? 'items-start py-3 pl-3.5' : 'items-center py-2 pl-4')}>
        {icon && (
          <span aria-hidden className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&>svg]:h-4 [&>svg]:w-4', level ? LEVEL_TINT[level] : 'bg-surface-2 text-muted')}>
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {item.title && <p className="break-words text-[13.5px] font-semibold leading-snug">{item.title}</p>}
          {item.message && (
            <p className={cn('break-words', item.title ? 'mt-0.5 line-clamp-2 text-muted' : 'leading-snug')}>{item.message}</p>
          )}
          {rich && item.action && (
            <button type="button" className="mt-2 inline-flex h-7 items-center rounded-control bg-surface-2 px-2.5 text-[12.5px] font-medium hover:bg-surface-hover pointer-coarse:h-9"
              onClick={() => { item.action?.onClick(); onDismiss() }}>
              {item.action.label}
            </button>
          )}
        </div>
        {!rich && item.action && (
          <button type="button" className="shrink-0 rounded-lg px-2 py-1 font-medium text-accent hover:bg-surface-hover"
            onClick={() => { item.action?.onClick(); onDismiss() }}>
            {item.action.label}
          </button>
        )}
        <button type="button" aria-label={t('Dismiss##close')} onClick={onDismiss}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-9 pointer-coarse:w-9">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* How much time is left: shrinks while the timer runs, stands still while it waits. */}
      <span aria-hidden data-testid="toast-time" style={{ animationDuration: `${duration}ms`, animationPlayState: paused || drag ? 'paused' : 'running' }}
        className={cn('toast-time absolute inset-x-0 bottom-0 h-0.5 origin-left', level ? LEVEL_EDGE[level] : 'bg-border-strong', 'opacity-60')} />
    </div>
  )
}

/**
 * Shows the notices queued with toast(). Mounted once in AppLayout. The newest three are
 * shown, the newest at the bottom; older ones fold into "+N more" (a click shows them all).
 * Their time waits while the pointer is over them or focus is in them (so a notice being
 * read doesn't go), and while the tab is hidden. They sit above the message box or the
 * phone's tab bar (`--toast-lift`, see useToastLift).
 */
export function ToastHost() {
  const { toasts, dismiss, remove, dismissAll } = useToasts()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const hidden = useSyncExternalStore(subscribeVisibility, pageHidden, () => false)
  const [opened, setExpanded] = useState(false)
  // All shown while asked for and there is more than fits; it folds again once there isn't.
  const live = toasts.filter((x) => !x.leaving).length
  const expanded = opened && live > VISIBLE_TOASTS
  if (!toasts.length) return null

  const shown = expanded ? toasts : toasts.slice(-VISIBLE_TOASTS)
  const folded = toasts.length - shown.length
  const paused = hovered || focused || hidden
  return (
    <section aria-label={t('Notices')} aria-live="polite"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
      className="pointer-events-none fixed inset-x-0 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+var(--toast-lift,0px))] z-[60] mx-auto flex w-full max-w-[min(26rem,100%)] flex-col items-stretch gap-2 px-3">
      {(folded > 0 || expanded) && (
        <div className="pointer-events-auto flex justify-center gap-1.5">
          <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
            className="rounded-full border border-border bg-card px-3 py-1 text-[12px] font-medium text-muted shadow-soft hover:text-text pointer-coarse:py-2">
            {expanded ? t('Show fewer') : plural(folded, '+{n} more', '+{n} more')}
          </button>
          <button type="button" onClick={() => { dismissAll(); setExpanded(false) }}
            className="rounded-full border border-border bg-card px-3 py-1 text-[12px] font-medium text-muted shadow-soft hover:text-text pointer-coarse:py-2">
            {t('Dismiss all')}
          </button>
        </div>
      )}
      <div className={cn('flex flex-col gap-2', expanded && 'pointer-events-auto max-h-[60vh] overflow-y-auto overscroll-contain')}>
        {shown.map((item) => (
          <Toast key={item.id} item={item} paused={paused} onRemove={() => remove(item.id)}
            onDismiss={() => {
              dismiss(item.id)
              if (live - 1 <= VISIBLE_TOASTS) setExpanded(false) // folds for good, not again with the next ones
            }} />
        ))}
      </div>
    </section>
  )
}
