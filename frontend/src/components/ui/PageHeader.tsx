import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getSlots, subscribe } from './topBarSlots'

/**
 * A page's title and its buttons. They are shown in the app's top bar, beside the
 * Dynamic Island, so every page starts at the same height and nothing moves when the
 * Island appears. `detail` is a short note after the title (a count, a date); the
 * children are the page's buttons, at the right end of the bar.
 *
 * Where there is no top bar (a page rendered on its own, as in a test), they are shown
 * in place instead.
 */
export function PageHeader({ title, detail, before, after, children }: {
  title: ReactNode
  detail?: ReactNode
  /** Controls right before and after the title (the calendar's previous and next). */
  before?: ReactNode
  after?: ReactNode
  children?: ReactNode
}) {
  const { start, end } = useSyncExternalStore(subscribe, getSlots)
  const heading = (
    <>
      {before}
      <h1 className="min-w-0 truncate text-[19px] font-bold tracking-tight">{title}</h1>
      {after}
      {detail && <span className="min-w-0 shrink truncate text-[13px] text-muted max-md:hidden">{detail}</span>}
    </>
  )
  if (!start || !end) {
    return (
      <div className="mb-4 flex items-center gap-2.5">
        {heading}
        {children && <div className="ml-auto flex items-center gap-1.5">{children}</div>}
      </div>
    )
  }
  return (
    <>
      {createPortal(heading, start)}
      {children && createPortal(children, end)}
    </>
  )
}
