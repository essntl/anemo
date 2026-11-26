import { cn } from '@/lib/cn'

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  /** For a <label htmlFor> elsewhere (SettingRow's title). */
  id?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        // A bigger hit area on touch screens, without making the switch look bigger.
        'before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[""]',
        checked ? 'bg-accent' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-white shadow-soft transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
