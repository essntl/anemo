import { Select } from '@/components/ui/Select'
import { type Level, usePermissionCatalog } from '@/features/agents/api'
import { useSettings } from '@/features/settings/api'

/**
 * Per-category permission overrides for a profile. "Same as Settings" keeps the
 * global level; the global ceiling still limits whatever is chosen here.
 */
export function ProfilePermissions({
  value,
  onChange,
}: {
  value: Record<string, Level>
  onChange: (levels: Record<string, Level>) => void
}) {
  const catalog = usePermissionCatalog()
  const settings = useSettings()
  const levels = catalog.data?.levels ?? []
  const label = (level: string) => levels.find((l) => l.level === level)?.label ?? level
  const globalLevels = settings.data?.permissions.levels ?? {}

  const set = (cap: string, level: string) => {
    const next = { ...value }
    if (level) next[cap] = level as Level
    else delete next[cap]
    onChange(next)
  }

  return (
    <div className="flex flex-col divide-y divide-border rounded-control border border-border">
      {catalog.data?.categories.map((cat) => {
        const global = (globalLevels[cat.capability] as string | undefined) ?? cat.default_level
        return (
          <div key={cat.capability} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-36 flex-1 text-[13px]">{cat.label}</span>
            <Select
              aria-label={`${cat.label} for this profile`}
              className="h-9 w-full text-[12.5px] sm:w-60"
              value={value[cat.capability] ?? ''}
              onValueChange={(v) => set(cat.capability, v)}
              options={[
                { value: '', label: `Same as Settings (${label(global)})` },
                ...levels
                  .filter((l) => cat.workspace_scoped || l.level !== 'workspace')
                  .map((l) => ({ value: l.level, label: l.label })),
              ]}
            />
          </div>
        )
      })}
    </div>
  )
}
