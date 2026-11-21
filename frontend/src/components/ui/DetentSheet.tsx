import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { MAX_PART, restingPlace, SAME } from './detents'

/** Whether a touch starting on `target` may move the sheet: not from a control that is dragged itself. */
function mayDrag(target: EventTarget | null): boolean {
  for (let el = target instanceof HTMLElement ? target : null; el; el = el.parentElement) {
    if (el instanceof HTMLTextAreaElement || el.dataset.noDrag !== undefined) return false
    if (el instanceof HTMLInputElement && el.type !== 'button') return false
  }
  return true
}

interface DetentSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /**
   * What is in it. With a `<SheetFold />` among it, the sheet opens as tall as what is
   * above the fold, and what is below comes into view when it is pulled up (or
   * scrolled with a wheel, or its bar is pressed).
   */
  children: ReactNode
}

/** Where a DetentSheet's first height ends. */
export function SheetFold() {
  return <div data-sheet-fold="" className="h-4" />
}

/**
 * A sheet that slides up from the bottom edge and rests at two heights: first as tall
 * as its main content, and, pulled up, as tall as everything in it (then it scrolls).
 * It follows the finger both ways; pulled or flicked down from the first height it
 * goes away. A tap outside, Esc and "back" close it too (it is a dialog: see
 * app/useBackToClose.ts).
 */
export function DetentSheet({ open, onOpenChange, title, children }: DetentSheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <RadixDialog.Content
          aria-describedby={undefined}
          // It moves by its own rules (two heights), not by those of the other sheets (app/useSheetSwipe.ts).
          data-no-swipe=""
          onOpenAutoFocus={(e) => {
            // Not the first button (that would scroll or show a focus ring for nothing): the sheet itself.
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).focus()
          }}
          className="sheet-detents fixed inset-x-0 bottom-0 z-50 mx-auto flex max-w-xl flex-col overflow-hidden rounded-t-[1.75rem] border border-b-0 border-border bg-card shadow-float focus:outline-none"
        >
          <Body title={title} onClose={() => onOpenChange(false)}>{children}</Body>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** The inside of the sheet. Mounted while it is open, so it can measure and move the sheet it is in. */
function Body({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const header = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [detent, setDetent] = useState<'half' | 'full'>('half')
  // The two heights (px), measured from what is in the sheet.
  const [sizes, setSizes] = useState<{ half: number; full: number } | null>(null)
  const state = useRef({ detent, sizes, onClose })
  useEffect(() => {
    state.current = { detent, sizes, onClose }
  })

  const sheet = () => header.current?.parentElement ?? null

  useLayoutEffect(() => {
    const measure = () => {
      if (!header.current || !scroller.current) return
      const fold = content.current?.querySelector<HTMLElement>('[data-sheet-fold]')
      const max = Math.round(window.innerHeight * MAX_PART)
      const top = header.current.offsetHeight
      const full = Math.min(max, top + scroller.current.scrollHeight)
      const half = fold ? Math.min(full, top + fold.offsetTop + fold.offsetHeight) : full
      setSizes((now) => (now && now.half === half && now.full === full ? now : { half, full }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (content.current) observer.observe(content.current)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Everything fits at the first height: there is nothing to pull up to.
  const single = !sizes || sizes.full - sizes.half <= SAME
  const atFull = detent === 'full' || single

  // The height follows the resting place; a finger sets it directly while it pulls.
  useLayoutEffect(() => {
    const el = sheet()
    if (el && sizes) el.style.height = `${detent === 'full' ? sizes.full : sizes.half}px`
  }, [detent, sizes])

  useEffect(() => {
    const el = sheet()
    const scroll = scroller.current
    if (!el || !scroll) return
    let pull: { y: number; at: number; start: number; moving: boolean; lastY: number; lastAt: number; velocity: number } | null = null

    const onStart = (e: TouchEvent) => {
      pull = null
      const { sizes: now, detent: at } = state.current
      if (!now || e.touches.length !== 1 || !mayDrag(e.target)) return
      const y = e.touches[0].clientY
      pull = { y, at: e.timeStamp, start: at === 'full' ? now.full : now.half, moving: false, lastY: y, lastAt: e.timeStamp, velocity: 0 }
    }
    const onMove = (e: TouchEvent) => {
      const { sizes: now, detent: at } = state.current
      if (!pull || !now) return
      const y = e.touches[0].clientY
      const dy = y - pull.y
      if (!pull.moving) {
        if (Math.abs(dy) < 8) return
        // Pulled all the way up it scrolls: only a pull down from its top moves the sheet.
        const scrolls = at === 'full' || now.full - now.half <= SAME
        if (scrolls && scroll.contains(e.target as Node) && (dy < 0 || scroll.scrollTop > 0)) {
          pull = null
          return
        }
        pull.moving = true
        el.style.transition = 'none'
      }
      if (e.cancelable) e.preventDefault()
      const dt = e.timeStamp - pull.lastAt
      if (dt > 0) pull.velocity = (y - pull.lastY) / dt
      pull.lastY = y
      pull.lastAt = e.timeStamp
      // Past the top it gives a little, then no more.
      const height = pull.start - dy
      el.style.height = `${height > now.full ? now.full + (height - now.full) * 0.15 : Math.max(0, height)}px`
    }
    const onEnd = (e: TouchEvent) => {
      const done = pull
      pull = null
      const { sizes: now, detent: at, onClose: close } = state.current
      if (!done?.moving || !now) return
      el.style.transition = ''
      // A finger that stopped before letting go is not flicking.
      const velocity = e.timeStamp - done.lastAt > 80 ? 0 : done.velocity
      const next = restingPlace({ height: el.offsetHeight, velocity, from: at }, now.half, now.full)
      if (next === 'closed') return close() // it leaves from where the finger let go
      el.style.height = `${next === 'full' ? now.full : now.half}px`
      setDetent(next)
    }
    // A mouse wheel or trackpad has no pull: scrolling down brings the rest up.
    const onWheel = (e: WheelEvent) => {
      const { sizes: now, detent: at } = state.current
      if (e.deltaY > 0 && at === 'half' && now && now.full - now.half > SAME) setDetent('full')
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  return (
    <>
      <div ref={header} className="shrink-0 touch-none px-3 pb-2">
        {/* The pull bar. Pressed (a mouse, a keyboard), it does what a pull does. */}
        <button type="button" disabled={single} onClick={() => setDetent(detent === 'full' ? 'half' : 'full')}
          aria-label={detent === 'full' ? t('Show less') : t('Show more')}
          className="mx-auto flex h-6 w-24 items-center justify-center focus-visible:outline-none">
          <span className="h-1 w-9 rounded-full bg-border-strong" />
        </button>
        <div className="relative flex h-11 items-center justify-center">
          <RadixDialog.Close className="absolute left-0 flex h-10 w-10 items-center justify-center rounded-full text-text hover:bg-surface-hover">
            <X className="h-5 w-5" />
            <span className="sr-only">{t('Close')}</span>
          </RadixDialog.Close>
          <RadixDialog.Title className="text-[15.5px] font-semibold">{title}</RadixDialog.Title>
        </div>
      </div>
      <div ref={scroller} className={cn('min-h-0 flex-1 overscroll-contain px-3', atFull ? 'overflow-y-auto' : 'touch-none overflow-hidden')}>
        <div ref={content} className="relative pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </>
  )
}
