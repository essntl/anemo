import { useModels } from '@/features/providers/api'

/** Compact select of enabled chat models. `value` null means "use the default". */
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
  const options = (models.data ?? []).filter((m) => m.enabled && m.capabilities.chat !== false)
  const current = value ?? defaultModelId ?? ''
  return (
    <select
      aria-label="Model"
      value={current}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-8 max-w-56 truncate rounded-lg bg-transparent px-2 text-[12.5px] text-muted hover:bg-surface-hover hover:text-text focus:outline-none"
    >
      {!current && <option value="">No model configured</option>}
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.display_name}
          {m.id === defaultModelId ? ' (default)' : ''}
        </option>
      ))}
    </select>
  )
}
