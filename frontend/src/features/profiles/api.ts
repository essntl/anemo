import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { withReauth } from '@/features/auth/reauthStore'

export type Profile = Schemas['ProfileOut']
export type ProfileInput = Schemas['ProfileIn']
export type Skill = Schemas['SkillOut']
export type SkillInput = Schemas['SkillIn']

export const profilesKey = ['profiles'] as const
export const skillsKey = ['skills'] as const

export function useProfiles() {
  return useQuery({
    queryKey: profilesKey,
    queryFn: async () => unwrap(await api.GET('/api/profiles')),
  })
}

export function useSaveProfile() {
  const qc = useQueryClient()
  return useMutation({
    // Changing a profile's permissions or limits asks for the password again.
    mutationFn: (v: { id?: string; body: ProfileInput }) =>
      withReauth(async () =>
        v.id
          ? unwrap(await api.PUT('/api/profiles/{profile_id}', { params: { path: { profile_id: v.id } }, body: v.body }))
          : unwrap(await api.POST('/api/profiles', { body: v.body })),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: profilesKey })
      void qc.invalidateQueries({ queryKey: ['permissions', 'summary'] })
    },
  })
}

export function useDeleteProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/profiles/{profile_id}', { params: { path: { profile_id: id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: profilesKey }),
  })
}

export function useSkills() {
  return useQuery({
    queryKey: skillsKey,
    queryFn: async () => unwrap(await api.GET('/api/skills')),
  })
}

export function useSaveSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; body: SkillInput }) =>
      v.id
        ? unwrap(await api.PUT('/api/skills/{skill_id}', { params: { path: { skill_id: v.id } }, body: v.body }))
        : unwrap(await api.POST('/api/skills', { body: v.body })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: skillsKey }),
  })
}

export function useImportSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { content: string; replace?: boolean }) =>
      unwrap(await api.POST('/api/skills/import', { body: { content: v.content, replace: v.replace ?? false } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: skillsKey }),
  })
}

export function useDeleteSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/skills/{skill_id}', { params: { path: { skill_id: id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: skillsKey })
      void qc.invalidateQueries({ queryKey: profilesKey })
    },
  })
}

export const skillExportUrl = (id: string) => `/api/skills/${id}/export`
