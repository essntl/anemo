/**
 * Agents: profiles (named agent setups) and skills (instructions agents load on
 * demand). The tab is kept in the URL (?tab=skills).
 */
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Bot, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import type { Profile, Skill } from '../api'
import { ProfileDialog } from '../components/ProfileDialog'
import { ProfileList } from '../components/ProfileList'
import { SkillDialog } from '../components/SkillDialog'
import { SkillList } from '../components/SkillList'
import { Lingering } from '@/components/ui/Lingering'

// Which dialog is open; `item` null means "create a new one".
type Editing = { kind: 'profile'; item: Profile | null } | { kind: 'skill'; item: Skill | null } | null

const TABS = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'skills', label: 'Skills' },
] as const

export function ProfilesPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'skills' ? 'skills' : 'profiles'
  const [editing, setEditing] = useState<Editing>(null)

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Profiles & Skills</h1>
          <p className="text-[13px] text-muted">
            Profiles are agent setups you pick in the chat. Skills are instructions agents load when a task needs them.
          </p>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Section">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              onClick={() => setParams(t.id === 'profiles' ? {} : { tab: t.id }, { replace: true })}
              className={cn('h-8 rounded-md px-3 text-[13px] font-medium transition-colors pointer-coarse:h-10',
                tab === t.id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {t.label}
            </button>
          ))}
        </div>
        <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(tab === 'profiles' ? { kind: 'profile', item: null } : { kind: 'skill', item: null })}>
          {tab === 'profiles' ? 'New profile' : 'New skill'}
        </Button>
      </div>

      {tab === 'profiles' ? (
        <ProfileList onEdit={(item) => setEditing({ kind: 'profile', item })} />
      ) : (
        <SkillList onEdit={(item) => setEditing({ kind: 'skill', item })} />
      )}
      <Lingering value={editing?.kind === 'profile' && editing}>{(shown) => <ProfileDialog profile={shown.item} onClose={() => setEditing(null)} />}</Lingering>
      <Lingering value={editing?.kind === 'skill' && editing}>{(shown) => <SkillDialog skill={shown.item} onClose={() => setEditing(null)} />}</Lingering>
    </div>
  )
}
