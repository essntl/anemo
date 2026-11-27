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

// -- permission profiles (docs/specs/25-device-permission-profiles.md) ----------------------

export type DeviceProfile = components['schemas']['DeviceProfileOut']
export type DevicePermissions = components['schemas']['DevicePermissionsOut']
export type WorkFolder = components['schemas']['WorkFolder']
export type CategoryLevel = DeviceProfile['categories'][string]
export type PermissionsChange = components['schemas']['DevicePermissionsIn']

export const deviceProfilesKey = ['devices', 'profiles'] as const
export const devicePermissionsKey = (id: string) => ['devices', id, 'permissions'] as const

/** The built-in presets and the custom profiles, with how many devices use each. */
export function useDeviceProfiles() {
  return useQuery({
    queryKey: deviceProfilesKey,
    queryFn: async () => unwrap(await api.GET('/api/devices/profiles')),
  })
}

/** One device's profile, work folders, protected folders, grants and automation switch. */
export function useDevicePermissions(id: string, enabled = true) {
  return useQuery({
    queryKey: devicePermissionsKey(id),
    queryFn: async () => unwrap(await api.GET('/api/devices/{device_id}/permissions', { params: { path: { device_id: id } } })),
    enabled,
  })
}

/** Changes what a device allows: security-sensitive, so the password is asked again. */
export function useSetPermissions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, change }: { id: string; change: PermissionsChange }) =>
      withReauth(async () =>
        unwrap(await api.PUT('/api/devices/{device_id}/permissions', { params: { path: { device_id: id } }, body: change })),
      ),
    onSuccess: (data, { id }) => {
      qc.setQueryData(devicePermissionsKey(id), data)
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: deviceProfilesKey })
    },
  })
}

export function useCopyProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { source_id: string; name: string }) =>
      withReauth(async () => unwrap(await api.POST('/api/devices/profiles', { body }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceProfilesKey }),
  })
}

export function useChangeProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; categories?: Record<string, CategoryLevel>; relevance_check?: boolean }) =>
      withReauth(async () =>
        unwrap(await api.PATCH('/api/devices/profiles/{profile_id}', { params: { path: { profile_id: id } }, body })),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deviceProfilesKey })
      void qc.invalidateQueries({ queryKey: devicesKey })
    },
  })
}

export function useDeleteProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      withReauth(async () => unwrap(await api.DELETE('/api/devices/profiles/{profile_id}', { params: { path: { profile_id: id } } }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: deviceProfilesKey }),
  })
}

/** Revokes a "the next hour" grant at once. */
export function useRevokeGrant(deviceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (grantId: string) =>
      unwrap(await api.DELETE('/api/devices/{device_id}/grants/{grant_id}', { params: { path: { device_id: deviceId, grant_id: grantId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: devicePermissionsKey(deviceId) }),
  })
}
