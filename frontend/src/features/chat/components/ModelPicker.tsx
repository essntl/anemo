import { Select } from '@/components/ui/Select'
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
    <Select
      aria-label="Model"
      variant="ghost"
      className="max-w-40 px-1 md:max-w-56 md:px-2"
      value={current}
      onValueChange={(v) => onChange(v || null)}
      options={[
        ...(!current ? [{ value: '', label: 'No model configured', disabled: true }] : []),
        ...(unavailable ? [{ value: current, label: `${unavailable} (unavailable)`, disabled: true }] : []),
        ...options.map((m) => ({
          value: m.id,
          label: `${m.display_name}${m.id === defaultModelId ? ' (default)' : ''}`,
        })),
      ]}
    />
  )
}
