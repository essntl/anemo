import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'

export type PropertyDefinition = Schemas['DefinitionOut']
export type PropertyOption = Schemas['OptionOut']
export type PropertyType = PropertyDefinition['type']
/** A property value as stored: a slug, a list of slugs, text, "YYYY-MM-DD", a number or a boolean. */
export type PropertyValue = string | number | boolean | string[]

export const propertiesKey = ['properties'] as const

/** Every property with its values (and how many documents use each). */
export function useProperties() {
  return useQuery({
    queryKey: propertiesKey,
    queryFn: async () => unwrap(await api.GET('/api/properties')),
    staleTime: 30_000,
  })
}

/** The properties that can be used on a document in this project (global ones and the project's own). */
export function propertiesFor(all: PropertyDefinition[], projectId: string | null): PropertyDefinition[] {
  return all.filter(
    (p) => p.applies_to.includes('document') && (p.project_ids === null || (projectId !== null && p.project_ids.includes(projectId))),
  )
}

/** How a value reads: option labels for select values, the text otherwise. */
export function valueLabel(definition: PropertyDefinition | undefined, value: unknown): string {
  if (value === null || value === undefined) return ''
  const label = (slug: unknown) => definition?.options.find((o) => o.slug === slug)?.label ?? String(slug)
  if (Array.isArray(value)) return value.map(label).join(', ')
  if (typeof value === 'boolean') return value ? '✓' : '–'
  return definition && (definition.type === 'select' || definition.type === 'multi_select') ? label(value) : String(value)
}

/** The closest existing values the server suggested for a refused value, if it did. */
export function suggestionsOf(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.code !== 'property_invalid') return []
  const details = err.details as { errors?: { suggestions?: string[] }[] } | undefined
  return details?.errors?.flatMap((e) => e.suggestions ?? []) ?? []
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: propertiesKey })
    void qc.invalidateQueries({ queryKey: ['documents'] })
    void qc.invalidateQueries({ queryKey: ['document'] })
    void qc.invalidateQueries({ queryKey: ['views'] })
  }
}

export function useCreateProperty() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (body: Schemas['DefinitionIn']) => unwrap(await api.POST('/api/properties', { body })),
    onSuccess: done,
  })
}

export function useUpdateProperty() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { id: string; body: Schemas['DefinitionPatch'] }) =>
      unwrap(await api.PATCH('/api/properties/{definition_id}', { params: { path: { definition_id: v.id } }, body: v.body })),
    onSuccess: done,
  })
}

export function useDeleteProperty() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/properties/{definition_id}', { params: { path: { definition_id: id } } })),
    onSuccess: done,
  })
}

export function useAddOption() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { definitionId: string; label: string }) =>
      unwrap(
        await api.POST('/api/properties/{definition_id}/options', {
          params: { path: { definition_id: v.definitionId } },
          body: { label: v.label, slug: null },
        }),
      ),
    onSuccess: done,
  })
}

export function useUpdateOption() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { definitionId: string; optionId: string; body: Schemas['OptionPatch'] }) =>
      unwrap(
        await api.PATCH('/api/properties/{definition_id}/options/{option_id}', {
          params: { path: { definition_id: v.definitionId, option_id: v.optionId } },
          body: v.body,
        }),
      ),
    onSuccess: done,
  })
}

export function useDeleteOption() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { definitionId: string; optionId: string }) =>
      unwrap(
        await api.DELETE('/api/properties/{definition_id}/options/{option_id}', {
          params: { path: { definition_id: v.definitionId, option_id: v.optionId } },
        }),
      ),
    onSuccess: done,
  })
}

export function useRenameOption() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { definitionId: string; optionId: string; slug: string }) =>
      unwrap(
        await api.POST('/api/properties/{definition_id}/options/{option_id}/rename', {
          params: { path: { definition_id: v.definitionId, option_id: v.optionId } },
          body: { slug: v.slug },
        }),
      ),
    onSuccess: done,
  })
}

export function useMergeOption() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (v: { definitionId: string; optionId: string; into: string }) =>
      unwrap(
        await api.POST('/api/properties/{definition_id}/options/{option_id}/merge', {
          params: { path: { definition_id: v.definitionId, option_id: v.optionId } },
          body: { into_option_id: v.into },
        }),
      ),
    onSuccess: done,
  })
}

export function useReindexDocuments() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async () => unwrap(await api.POST('/api/properties/reindex')),
    onSuccess: done,
  })
}
