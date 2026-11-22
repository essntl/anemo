import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { tokensKey } from '@/features/auth/api'
import { withReauth } from '@/features/auth/reauthStore'

export type Device = components['schemas']['DeviceOut']
export type DeviceKind = Device['kind']
export type DeviceTrust = Device['trust']

export const devicesKey = ['devices'] as const

/** Every device, with whether it is connected now (refreshed while the page is open). */
export function useDevices() {
  return useQuery({
    queryKey: devicesKey,
    queryFn: async () => unwrap(await api.GET('/api/devices')),
    refetchInterval: 15_000,
  })
}

/** A new device and its token (shown once). Needs the password confirmed: the token is a login. */
export function useAddDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; kind: DeviceKind; trust: DeviceTrust }) =>
      withReauth(async () => unwrap(await api.POST('/api/devices', { body }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: tokensKey })
    },
  })
}

export function useRenameDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      unwrap(await api.PATCH('/api/devices/{device_id}', { params: { path: { device_id: id } }, body: { name } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: tokensKey })
    },
  })
}

/** Watched or trusted: a security-sensitive change, so the password is asked again. */
export function useSetTrust() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, trust }: { id: string; trust: DeviceTrust }) =>
      withReauth(async () =>
        unwrap(await api.PUT('/api/devices/{device_id}/trust', { params: { path: { device_id: id } }, body: { trust } })),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: devicesKey }),
  })
}

/** Deletes the device and its token; its connection closes at once. */
export function useDeleteDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/devices/{device_id}', { params: { path: { device_id: id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: tokensKey })
    },
  })
}
