import { PageReadError, readPage, type PageContext } from '@/shared/pageContext'
import type { Api } from '@/shared/api'
import type { PageState } from './PagePreview'

/** The tab the user looks at: the active tab of the last focused browser window (the side
 *  panel belongs to that window), or of any browser window when a popup has the focus. */
export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' })
  if (tab) return tab
  const [any] = await chrome.tabs.query({ active: true, windowType: 'normal' })
  return any
}

/** Reads the active tab's page; the state to show. */
export async function readActivePage(api: Api): Promise<PageState> {
  const tab = await activeTab()
  if (!tab) return { status: 'error', failure: { reason: 'failed', message: 'No tab is open.' } }
  try {
    const page: PageContext = await readPage(api, tab)
    return { status: 'ready', page }
  } catch (err) {
    if (err instanceof PageReadError) return { status: 'error', failure: err.failure }
    return { status: 'error', failure: { reason: 'failed', message: err instanceof Error ? err.message : String(err) } }
  }
}
