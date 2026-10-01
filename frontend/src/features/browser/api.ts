import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

/** What the conversation's browser shows right now. */
export type BrowserView = Schemas['BrowserView']
/** Something the user does in it: a click, typed text, a key, scrolling, an address… */
export type BrowserInput = Schemas['BrowserInput']

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
 * The live view. While `watching`, it is fetched again every second, so the
 * picture follows what the agent (or you) does. It stops while the tab is hidden.
 */
export function useBrowserView(conversationId: string, watching: boolean) {
  return useQuery({
    queryKey: browserKey(conversationId),
    enabled: watching,
    refetchInterval: watching ? 1000 : false,
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
    mutationFn: async (input: BrowserInput) =>
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/browser/input', {
          params: { path: { conversation_id: conversationId } },
          body: input,
        }),
      ),
    onSuccess: (view) => qc.setQueryData(browserKey(conversationId), view),
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
