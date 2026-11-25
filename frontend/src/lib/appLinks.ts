/**
 * Links from one thing in the app to another, as written into Markdown (task notes,
 * documents). They are plain addresses of the app's own pages, so they also work when
 * pasted into a chat or opened in a new tab.
 */
export const documentLink = (id: string) => `/documents/${id}`
export const taskLink = (id: string) => `/tasks?task=${id}`
/** A calendar event (the calendar opens on its day with the event shown). */
export const eventLink = (id: string) => `/calendar?event=${id}`
export const chatLink = (id: string) => `/c/${id}`
/** A Claude Code job on the Code page (its whole thread). */
export const codeJobLink = (id: string) => `/code/${id}`
/** A file in Files: "/files?path=projects/thesis/draft.pdf" (slashes kept for readability). */
export const fileLink = (path: string) => `/files?path=${encodeURIComponent(path).replace(/%2F/g, '/')}`

/** An address inside this app ("/documents/…", "?doc=2") rather than another site. */
export function isAppLink(href: string): boolean {
  // "//host" and "/\host" are other sites to a browser, not paths of this app.
  return (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) || href.startsWith('?')
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const DOCUMENT_ADDRESS = new RegExp(`^/documents/(${UUID})$`, 'i')
const SKETCH_PREVIEW = new RegExp(`^/api/documents/(${UUID})/sketch/preview$`, 'i')

/** The image of a sketch document, as the app serves it (so it shows without asking). */
export const sketchPreviewUrl = (id: string) => `/api/documents/${id}/sketch/preview`

/**
 * A sketch is embedded in Markdown as an image whose address is the sketch's page:
 * `![Title](/documents/<id>)`. Returns the id when `src` is such an address.
 */
export function embeddedSketchId(src: string | null | undefined): string | null {
  return (src && DOCUMENT_ADDRESS.exec(src)?.[1]) || null
}

/** The id of the sketch whose image `src` is (the editor shows embeds by their image). */
export function sketchIdOfPreview(src: string | null | undefined): string | null {
  return (src && SKETCH_PREVIEW.exec(src)?.[1]) || null
}
