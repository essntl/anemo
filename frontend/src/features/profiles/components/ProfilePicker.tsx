import { Select } from '@/components/ui/Select'
import { useProfiles } from '../api'

/** Which agent profile an agent-mode message uses ("" = the default agent). */
export function ProfilePicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const profiles = useProfiles()
  if (!profiles.data?.length) return null // nothing to choose until a profile exists
  return (
    <Select
      variant="ghost"
      aria-label="Agent profile"
      className="max-w-40"
      value={value ?? ''}
      onValueChange={(v) => onChange(v || null)}
      options={[
        { value: '', label: 'Default agent' },
        ...profiles.data.map((p) => ({ value: p.id, label: p.name })),
      ]}
    />
  )
}
