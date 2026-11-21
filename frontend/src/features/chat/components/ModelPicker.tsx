import { Select } from '@/components/ui/Select'
import { useModels } from '@/features/providers/api'
import { t } from '@/lib/i18n'
import { canSetEffort } from '../reasoning'
import { ReasoningControl } from './ReasoningControl'

/**
 * Compact select of usable chat models (model and its provider both enabled).
 * `value` null means "use the default". A chosen model that has since been turned
 * off stays visible, marked unavailable, so it's clear why sending fails.
 * A model that can reason gets the reasoning slider's button next to it.
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
    ? (all.find((m) => m.id === current)?.display_name ?? t('Deleted model'))
    : null
  const reasons = canSetEffort(all.find((m) => m.id === current))
  return (
    <>
      <Select
        aria-label={t('Model')}
        variant="ghost"
        className="max-w-56"
        value={current}
        onValueChange={(v) => onChange(v || null)}
        options={[
          ...(!current ? [{ value: '', label: t('No model configured'), disabled: true }] : []),
          ...(unavailable ? [{ value: current, label: t('{name} (unavailable)', { name: unavailable }), disabled: true }] : []),
          ...options.map((m) => ({
            value: m.id,
            label: m.id === defaultModelId ? t('{name} (default)', { name: m.display_name }) : m.display_name,
          })),
        ]}
      />
      {reasons && <ReasoningControl />}
    </>
  )
}
