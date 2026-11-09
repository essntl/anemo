/** What to tell the user when a page couldn't be read. */
import type { ReadFailure } from './pageContext'

export function failureMessage(f: ReadFailure): { title: string; body: string } {
  switch (f.reason) {
    case 'restricted':
      return { title: 'This page can’t be read', body: 'Chrome doesn’t let extensions read its own pages, the Web Store or other extensions.' }
    case 'no_access':
      return {
        title: 'Anemo can’t read this tab from the panel yet',
        body: 'Click the Anemo toolbar icon while on that tab (or use the right-click menu on the page), then try again. After that you can let Anemo always read this site.',
      }
    case 'pdf':
      return { title: 'The PDF couldn’t be read', body: f.message }
    case 'empty':
      return { title: 'Nothing to read', body: 'The page has no text Anemo could find.' }
    default:
      return { title: 'The page couldn’t be read', body: f.message }
  }
}
