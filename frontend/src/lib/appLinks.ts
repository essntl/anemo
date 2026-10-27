/**
 * Links from one thing in the app to another, as written into Markdown (task notes,
 * documents). They are plain addresses of the app's own pages, so they also work when
 * pasted into a chat or opened in a new tab.
 */
export const documentLink = (id: string) => `/documents/${id}`
export const taskLink = (id: string) => `/tasks?task=${id}`
/** A file in Files: "/files?path=projects/thesis/draft.pdf" (slashes kept for readability). */
export const fileLink = (path: string) => `/files?path=${encodeURIComponent(path).replace(/%2F/g, '/')}`

/** An address inside this app ("/documents/…", "?doc=2") rather than another site. */
export function isAppLink(href: string): boolean {
  return (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('?')
}
