import { useModels } from '@/features/providers/api'

/**
 * Compact select of usable chat models (model and its provider both enabled).
 * `value` null means "use the default". A chosen model that has since been turned
 * off stays visible, marked unavailable, so it's clear why sending fails.
 */
export function ModelPicker({
  value,
  defaultModelId,
  onChange,
}: {
  value: string | null
  defaultModelId: string | null
  onChange: (id: string | null) => void
}) {
  const models = useModels()
  const all = models.data ?? []
  const options = all.filter((m) => m.enabled && m.provider_enabled && m.capabilities.chat !== false)
  const current = value ?? defaultModelId ?? ''
  const unavailable = current && models.data && !options.some((m) => m.id === current)
    ? (all.find((m) => m.id === current)?.display_name ?? 'Deleted model')
    : null
  return (
    <select
      aria-label="Model"
      value={current}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-8 min-w-0 max-w-56 truncate rounded-lg bg-transparent px-1 text-[12.5px] md:px-2 pointer-coarse:h-10 text-muted hover:bg-surface-hover hover:text-text focus:outline-none"
    >
      {!current && <option value="">No model configured</option>}
      {unavailable && <option value={current}>{unavailable} (unavailable)</option>}
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.display_name}
          {m.id === defaultModelId ? ' (default)' : ''}
        </option>
      ))}
    </select>
  )
}
