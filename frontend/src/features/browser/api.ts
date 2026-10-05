import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

/** What the conversation's browser shows right now. */
export type BrowserView = Schemas['BrowserView']
/** Something the user does in it: a click, typed text, a key, scrolling, an address…
 *  (`picture` is added when it is sent: see useInputQueue). */
export type BrowserInput = Omit<Schemas['BrowserInput'], 'picture'>

export const browserKey = (conversationId: string) => ['browser', conversationId] as const

/** Whether the optional browser container is running at all. */
export function useBrowserStatus() {
  return useQuery({
    queryKey: ['browser', 'status'],
    queryFn: async () => unwrap(await api.GET('/api/browser/status')),
    staleTime: 30_000,
  })
}

/**
 * The view (whether a page is open, its address, a picture). While `watching`, it is
 * fetched again every `everyMs`: every second when there is no live picture
 * (useBrowserStream), rarely when there is. It stops while the tab is hidden.
 */
export function useBrowserView(conversationId: string, watching: boolean, everyMs = 1000) {
  return useQuery({
    queryKey: browserKey(conversationId),
    enabled: watching,
    refetchInterval: watching ? everyMs : false,
    refetchIntervalInBackground: false,
    queryFn: async () =>
      unwrap(
        await api.GET('/api/conversations/{conversation_id}/browser', {
          params: { path: { conversation_id: conversationId } },
        }),
      ),
  })
}

/** Send one thing the user did; the answer is the view afterwards, shown at once. */
export function useBrowserInput(conversationId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: Schemas['BrowserInput']) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/browser/input', {
          params: { path: { conversation_id: conversationId } },
          body: input,
        }),
      ),
    // Sent without a picture (the live stream shows it): keep the one we have.
    onSuccess: (view) =>
      qc.setQueryData<BrowserView>(browserKey(conversationId), (old) => ({ ...view, screenshot: view.screenshot ?? old?.screenshot ?? null })),
  })
}

/** Close the browser: its cookies and logins are gone. */
export function useCloseBrowser(conversationId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE('/api/conversations/{conversation_id}/browser', {
          params: { path: { conversation_id: conversationId } },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: browserKey(conversationId) }),
  })
}
