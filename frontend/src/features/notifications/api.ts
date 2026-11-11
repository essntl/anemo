import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { withReauth } from '@/features/auth/reauthStore'
import { msg } from '@/lib/i18n'
import { deviceName, endpointHash, subscribeThisDevice, unsubscribeThisDevice } from './push'

export type Notification = Schemas['NotificationOut']
export type NotificationKind = Notification['kind']
export type Destination = Schemas['DestinationOut']

export const notificationsKey = ['notifications'] as const
export const destinationsKey = ['notification-destinations'] as const

/** What a destination can receive, in the words used in Settings. */
export const KIND_LABELS: Record<NotificationKind, string> = {
  reminder: msg('Reminders for tasks and events'),
  automation: msg('Results of automations'),
  approval: msg('An automation needs my approval, or an agent asks me something'),
  agent: msg('Messages agents send me'),
  focus: msg('The focus timer finished a phase'),
}

const PAGE = 30

/** Notifications, newest first, loaded page by page. */
export function useNotifications(unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: [...notificationsKey, 'list', unreadOnly],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/notifications', {
          params: { query: { unread: unreadOnly, limit: PAGE, ...(pageParam ? { before: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].created_at : null),
  })
}

/** The unread count (sidebar badge). */
export function useNotificationSummary() {
  return useQuery({
    queryKey: [...notificationsKey, 'summary'],
    queryFn: async () => unwrap(await api.GET('/api/notifications/summary')),
  })
}

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: notificationsKey })
}

/** Mark some notifications as read; without ids, all of them. */
export function useMarkRead() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (ids?: string[]) =>
      unwrap(await api.POST('/api/notifications/read', { body: { ids: ids ?? null } })),
    onSuccess: refresh,
  })
}

export function useDeleteNotification() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/notifications/{notification_id}', { params: { path: { notification_id: id } } })),
    onSuccess: refresh,
  })
}

export function useClearNotifications() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async () => unwrap(await api.DELETE('/api/notifications')),
    onSuccess: refresh,
  })
}

// -- destinations (Settings > Notifications) ---------------------------------------------

export function useDestinations() {
  return useQuery({
    queryKey: destinationsKey,
    queryFn: async () => unwrap(await api.GET('/api/notification-destinations')),
  })
}

export interface DestinationForm {
  name: string
  /** Empty when editing: keep the saved webhook URL. */
  url: string
  enabled: boolean
  kinds: NotificationKind[]
}

/** Create or change a destination. Asks for the password first (it holds a credential). */
export function useSaveDestination() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id?: string; form: DestinationForm }) =>
      withReauth(async () => {
        const { name, url, enabled, kinds } = v.form
        if (!v.id) {
          // New destinations made here are always Discord channels (devices subscribe
          // through useEnablePush).
          return unwrap(
            await api.POST('/api/notification-destinations', { body: { name, url, enabled, kinds, type: 'discord' } }),
          )
        }
        return unwrap(
          await api.PATCH('/api/notification-destinations/{destination_id}', {
            params: { path: { destination_id: v.id } },
            body: { name, enabled, kinds, ...(url ? { url } : {}) },
          }),
        )
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: destinationsKey }),
  })
}

export function useDeleteDestination() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      withReauth(async () =>
        unwrap(
          await api.DELETE('/api/notification-destinations/{destination_id}', {
            params: { path: { destination_id: id } },
          }),
        ),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: destinationsKey }),
  })
}

/** Send a test message now; the result says whether it worked. */
export function useTestDestination() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await api.POST('/api/notification-destinations/{destination_id}/test', {
          params: { path: { destination_id: id } },
        }),
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: destinationsKey }),
  })
}

// -- push on this device ------------------------------------------------------------------

/** Turn push on for this browser (asks the browser, then the password if needed). */
export function useEnablePush() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      subscribeThisDevice((sub) =>
        withReauth(async () =>
          unwrap(
            await api.POST('/api/push/subscriptions', {
              body: {
                endpoint: sub.endpoint ?? '',
                keys: { p256dh: sub.keys?.p256dh ?? '', auth: sub.keys?.auth ?? '' },
                name: deviceName(navigator.userAgent, navigator.maxTouchPoints),
              },
            }),
          ),
        ),
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: destinationsKey }),
  })
}

/** Turn push off for this browser, and remove it from the list of devices. */
export function useDisablePush() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (devices: Destination[]) => {
      const endpoint = await unsubscribeThisDevice()
      if (!endpoint) return
      const hash = await endpointHash(endpoint)
      const own = devices.find((d) => d.endpoint_hash === hash)
      // If this is not confirmed, the server finds out on its own: the push service
      // answers "gone" to the next notification and the device is removed then.
      if (own) {
        await withReauth(async () =>
          unwrap(
            await api.DELETE('/api/notification-destinations/{destination_id}', {
              params: { path: { destination_id: own.id } },
            }),
          ),
        )
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: destinationsKey }),
  })
}
