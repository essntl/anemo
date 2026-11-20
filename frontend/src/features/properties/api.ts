import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { plural } from '@/lib/i18n'

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

/**
 * The properties that can be used on a document (or a task, an event) in this project:
 * global ones and the project's own.
 */
export function propertiesFor(
  all: PropertyDefinition[],
  projectId: string | null,
  objectType: 'document' | 'task' | 'event' = 'document',
): PropertyDefinition[] {
  return all.filter(
    (p) => p.applies_to.includes(objectType) && (p.project_ids === null || (projectId !== null && p.project_ids.includes(projectId))),
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

export type PropertySuggestion = Schemas['SuggestionOut']
export const suggestionsKey = ['properties', 'suggestions'] as const

/** Properties the assistant suggested for documents, waiting for the user. */
export function useSuggestions() {
  return useQuery({
    queryKey: suggestionsKey,
    queryFn: async () => unwrap(await api.GET('/api/properties/suggestions')),
  })
}

export function useApplySuggestions() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (ids: string[]) => unwrap(await api.POST('/api/properties/suggestions/apply', { body: { ids } })),
    onSuccess: done,
  })
}

export function useDismissSuggestions() {
  const done = useInvalidate()
  return useMutation({
    mutationFn: async (ids: string[]) => unwrap(await api.POST('/api/properties/suggestions/dismiss', { body: { ids } })),
    onSuccess: done,
  })
}

/** What to send for a task or event: the values set, and null for each one taken away. */
export function propertyChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) changes[key] = value
  }
  for (const key of Object.keys(before)) if (!(key in after)) changes[key] = null
  return changes
}

/**
 * The values an item of `objectType` in this project can have, out of `values` (a new
 * task from a document gets the document's properties that tasks can have).
 */
export function valuesFor(
  all: PropertyDefinition[],
  values: Record<string, unknown>,
  projectId: string | null,
  objectType: 'document' | 'task' | 'event',
): Record<string, unknown> {
  const allowed = new Set(propertiesFor(all, projectId, objectType).map((p) => p.key))
  return Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)))
}

// -- tags that name a value of another property (a client's tag) -------------------------------

export type TagSuggestion = Schemas['TagValueOut']
export const tagSuggestionsKey = ['properties', 'tag-suggestions'] as const

/** Tags that name a value of another property, offered to be turned into that value. */
export function useTagSuggestions() {
  return useQuery({
    queryKey: tagSuggestionsKey,
    staleTime: 60_000,
    queryFn: async () => unwrap(await api.GET('/api/properties/tag-suggestions')),
  })
}

function useTagsChanged() {
  const qc = useQueryClient()
  const done = useInvalidate()
  return () => {
    done()
    void qc.invalidateQueries({ queryKey: tagSuggestionsKey })
    void qc.invalidateQueries({ queryKey: ['tasks'] })
    void qc.invalidateQueries({ queryKey: ['calendar'] })
  }
}

export function useApplyTagSuggestion() {
  const changed = useTagsChanged()
  return useMutation({
    mutationFn: async (s: Pick<TagSuggestion, 'tag' | 'key' | 'value'>) =>
      unwrap(await api.POST('/api/properties/tag-suggestions/apply', { body: { tag: s.tag, key: s.key, value: s.value } })),
    onSuccess: changed,
  })
}

export function useDismissTagSuggestion() {
  const changed = useTagsChanged()
  return useMutation({
    mutationFn: async (s: Pick<TagSuggestion, 'tag' | 'key' | 'value'>) =>
      unwrap(await api.POST('/api/properties/tag-suggestions/dismiss', { body: { tag: s.tag, key: s.key, value: s.value } })),
    onSuccess: changed,
  })
}

/** "2 documents, 3 tasks" */
export function itemsText(s: { documents: number; tasks: number; events: number }): string {
  return [
    s.documents ? plural(s.documents, '{n} document', '{n} documents') : '',
    s.tasks ? plural(s.tasks, '{n} task', '{n} tasks') : '',
    s.events ? plural(s.events, '{n} event', '{n} events') : '',
  ].filter(Boolean).join(', ')
}
