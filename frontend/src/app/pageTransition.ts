import type { To } from 'react-router'

/** The first part of a path, which names the page: `/code/abc` -> `code`, `/` -> ``. */
export function sectionOf(path: string): string {
  return path.split(/[?#]/)[0].split('/')[1] ?? ''
}

/**
 * Whether going to `to` from `current` (a pathname) stays on the same page, so the page
 * doesn't cross-fade (styles/app.css, `.page`): only the address after `?` or `#`
 * changes (tabs, filters, search as you type), or another item of the same page opens
 * (`/code/a` -> `/code/b`, `/settings/general` -> `/settings/pages`). The page's list
 * and frame stay where they are, and the item's own area fades in (`.swap-in`): when
 * the whole page faded out and in for that, switching items blinked.
 */
export function staysOnPage(to: To | null, current: string): boolean {
  if (to === null) return true
  const path = typeof to === 'string' ? to : to.pathname
  if (path === undefined || path === '' || path.startsWith('?') || path.startsWith('#')) return true
  const target = path.split(/[?#]/)[0]
  if (target === current) return true
  // A relative path (no leading slash) stays inside the current page.
  if (!target.startsWith('/')) return true
  return sectionOf(target) === sectionOf(current) && sectionOf(target) !== ''
}
