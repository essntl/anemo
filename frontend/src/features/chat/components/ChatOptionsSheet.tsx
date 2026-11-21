import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, Search } from 'lucide-react'
import { DetentSheet, SheetFold } from '@/components/ui/DetentSheet'
import { type Mode, PermissionOverview } from '@/features/agents/components/ModeSwitch'
import { useProfiles } from '@/features/profiles/api'
import { useModels } from '@/features/providers/api'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useReasoningEffort } from '../api'
import { canSetEffort, EFFORT_LEVELS, effortIndex } from '../reasoning'
import { rememberModel, shortlist } from '../recentModels'
import { EffortSlider } from './EffortSlider'

interface ChatOptionsProps {
  /** The model in use (the chosen one, or the default). */
  modelId: string | null
  defaultModelId: string | null
  /** null: back to the default. */
  onModel: (id: string | null) => void
  mode: Mode
  profileId: string | null
  onProfile: (id: string | null) => void
}

/** With more models than this outside the short list, they get a search box. */
const SEARCH_FROM = 8

/**
 * The message box's options on a phone, as a sheet from the bottom: a short list of
 * models, then a bar each for the reasoning level and (in Agent mode) the agent's
 * profile and permissions. Pulled up, it shows every other model.
 */
export function ChatOptionsSheet({ open, onOpenChange, ...options }: ChatOptionsProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <DetentSheet open={open} onOpenChange={onOpenChange} title={t('Model and options')}>
      {/* Mounted while open: which models are listed first is decided when it opens,
          and stays, so nothing moves under the finger after a choice. */}
      {open && <Options {...options} />}
    </DetentSheet>
  )
}

type Bar = 'reasoning' | 'profile' | 'permissions'

function Options({ modelId, defaultModelId, onModel, mode, profileId, onProfile }: ChatOptionsProps) {
  const all = useModels().data ?? []
  const usable = all.filter((m) => m.enabled && m.provider_enabled && m.capabilities.chat !== false)
  const [firstIds] = useState(() => shortlist(usable, modelId, defaultModelId).map((m) => m.id))
  // The list can arrive after the sheet opened: until one was made, make it now.
  const first = firstIds.length ? usable.filter((m) => firstIds.includes(m.id)) : shortlist(usable, modelId, defaultModelId)
  const others = usable.filter((m) => !first.includes(m))
  const [query, setQuery] = useState('')
  const words = query.trim().toLowerCase()
  const found = words ? others.filter((m) => `${m.display_name} ${m.provider_name}`.toLowerCase().includes(words)) : others
  const current = all.find((m) => m.id === modelId)
  const unavailable = current && !usable.includes(current)

  const effort = useReasoningEffort()
  const level = EFFORT_LEVELS[effortIndex(effort.value)]
  const profiles = useProfiles().data ?? []
  const [bar, setBar] = useState<Bar | null>(null)
  const toggle = (which: Bar) => setBar(bar === which ? null : which)

  const choose = (id: string) => {
    rememberModel(id)
    onModel(id === defaultModelId ? null : id)
  }
  const row = (m: (typeof usable)[number]) => (
    <Row key={m.id} value={m.id} checked={m.id === modelId} onClick={() => choose(m.id)}
      title={m.display_name} detail={m.id === defaultModelId ? t('{provider} · Default', { provider: m.provider_name }) : m.provider_name} />
  )

  return (
    <>
      <Group label={t('Model')}>
        {first.map(row)}
        {first.length === 0 && <p className="px-4 py-3.5 text-[13.5px] text-muted">{t('No model configured')}</p>}
      </Group>
      {unavailable && (
        <p className="px-4 pt-2 text-[12.5px] text-warning">{t('{name} (unavailable)', { name: current.display_name })}</p>
      )}

      <div className="mt-3 overflow-hidden rounded-card bg-surface-2">
        {canSetEffort(current) && (
          <Setting label={t('Reasoning')} value={t(level.label)} open={bar === 'reasoning'} onToggle={() => toggle('reasoning')}>
            {/* The slider is dragged sideways: a touch on it must not move the sheet. */}
            <div data-no-drag="" className="px-1 pb-1">
              <p className="text-[12.5px] text-muted">{t(level.hint)}</p>
              <EffortSlider value={effort.value} onChange={effort.set} disabled={!effort.ready} />
            </div>
          </Setting>
        )}
        {mode === 'agent' && profiles.length > 0 && (
          <Setting label={t('Agent profile')} value={profiles.find((p) => p.id === profileId)?.name ?? t('Default agent')}
            open={bar === 'profile'} onToggle={() => toggle('profile')}>
            <div role="radiogroup" aria-label={t('Agent profile')} className="-mx-3 -mb-1">
              <Row checked={profileId === null} onClick={() => onProfile(null)} title={t('Default agent')} flat />
              {profiles.map((p) => (
                <Row key={p.id} checked={p.id === profileId} onClick={() => onProfile(p.id)} title={p.name} detail={p.description || undefined} flat />
              ))}
            </div>
          </Setting>
        )}
        {mode === 'agent' && (
          <Setting label={t('Permissions')} open={bar === 'permissions'} onToggle={() => toggle('permissions')}>
            <div className="pb-1 text-[13px]"><PermissionOverview profileId={profileId} heading={false} /></div>
          </Setting>
        )}
      </div>

      {others.length > 0 && (
        // Below the fold: pulled up into view.
        <>
          <SheetFold />
          <p className="px-4 pb-2 text-[13px] text-muted">{t('Other models')}</p>
          {others.length > SEARCH_FROM && (
            <label className="mb-2 flex h-11 items-center gap-2.5 rounded-card bg-surface-2 px-4 text-muted focus-within:text-text">
              <Search className="h-4 w-4 shrink-0" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search models')} aria-label={t('Search models')}
                className="min-w-0 flex-1 bg-transparent text-[14.5px] text-text placeholder:text-subtle focus:outline-none" />
            </label>
          )}
          <Group label={t('Other models')}>
            {found.map(row)}
            {found.length === 0 && <p className="px-4 py-3.5 text-[13.5px] text-muted">{t('No model matches “{query}”.', { query })}</p>}
          </Group>
        </>
      )}
    </>
  )
}

/** A list of choices in one rounded block, a hairline between them. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="divide-y divide-bg overflow-hidden rounded-card bg-surface-2">
      {children}
    </div>
  )
}

/** One choice: its name, a quieter line under it, and a tick when it is the chosen one. */
function Row({ title, detail, value, checked, onClick, flat }: { title: string; detail?: string; value?: string; checked: boolean; onClick: () => void; flat?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={checked} data-value={value} onClick={onClick}
      className={cn('flex w-full items-center gap-3 px-4 text-left transition-colors hover:bg-surface-hover active:bg-surface-hover', flat ? 'min-h-11 py-2' : 'min-h-14 py-2.5')}>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate font-medium', flat ? 'text-[14px]' : 'text-[15px]')}>{title}</span>
        {detail && <span className="block truncate text-[12.5px] text-muted">{detail}</span>}
      </span>
      {checked && <Check className="h-5 w-5 shrink-0 text-accent" aria-hidden />}
    </button>
  )
}

/** A bar for one setting: its name, what it is set to, and, opened, the control for it. */
function Setting({ label, value, open, onToggle, children }: { label: string; value?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="border-b border-bg last:border-b-0">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex min-h-14 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-surface-hover active:bg-surface-hover">
        <span className="flex-1 text-[15px] font-medium">{label}</span>
        {value && <span className="min-w-0 truncate text-[14px] text-muted">{value}</span>}
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}
