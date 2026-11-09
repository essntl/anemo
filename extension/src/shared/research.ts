/** Adding the page in a tab to the active research session (panel, right-click, shortcut). */
import { unwrap, type Api, type Schemas } from './api'
import { readPage, type PageContext } from './pageContext'
import { formatTimestamp, parseVideoUrl, timestampLink } from './youtube'
import { readPlayer, type PlayerState } from './youtubePage'

export type ResearchSession = Schemas['ResearchSessionOut']
export const SOURCE_MAX = 130_000

export async function activeSession(api: Api): Promise<ResearchSession | null> {
  const list = unwrap(await api.GET('/api/research/sessions'))
  return list.find((s) => s.status === 'active') ?? null
}

/** A YouTube video becomes a source at the moment you're at (its link jumps there). */
async function atMoment(tab: chrome.tabs.Tab, page: PageContext): Promise<PageContext> {
  const video = parseVideoUrl(tab.url)
  if (video?.kind !== 'video' || tab.id === undefined) return page
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPlayer })
    const state = r.result as PlayerState
    return { ...page, url: timestampLink(video.id, state.currentTime), title: `${state.title || page.title} @ ${formatTimestamp(state.currentTime)}` }
  } catch {
    return page
  }
}

/** What to add: the whole page, the selection (an error if there is none), or the
 *  selection if there is one and the page otherwise (the shortcut). */
export type AddMode = 'page' | 'selection' | 'auto'

/** Reads the tab (or its selection) and adds it to the session as a source. */
export async function addToResearch(api: Api, sessionId: string, tab: chrome.tabs.Tab, opts: { mode: AddMode; note?: string }) {
  let page = await readPage(api, tab, { limit: SOURCE_MAX, preferSelection: opts.mode !== 'page' })
  if (opts.mode === 'selection' && page.source !== 'selection') throw new Error('Nothing is selected on the page.')
  // No selection on a video: its transcript, not the watch page's text.
  if (opts.mode === 'auto' && page.source !== 'selection' && parseVideoUrl(tab.url)?.kind === 'video') {
    page = await readPage(api, tab, { limit: SOURCE_MAX })
  }
  if (page.source !== 'selection') page = await atMoment(tab, page)
  return unwrap(
    await api.POST('/api/research/sessions/{session_id}/sources', {
      params: { path: { session_id: sessionId } },
      body: { kind: page.source, url: page.url, title: page.title, content: page.content, note: opts.note ?? '' },
    }),
  )
}
