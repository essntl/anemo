/**
 * Agents: profiles (named agent setups) and skills (instructions agents load on
 * demand). The tab is kept in the URL (?tab=skills).
 */
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { msg, t } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import type { Profile, Skill } from '../api'
import { ProfileDialog } from '../components/ProfileDialog'
import { ProfileList } from '../components/ProfileList'
import { SkillDialog } from '../components/SkillDialog'
import { SkillList } from '../components/SkillList'
import { Lingering } from '@/components/ui/Lingering'
import { PageHeader } from '@/components/ui/PageHeader'

// Which dialog is open; `item` null means "create a new one".
type Editing = { kind: 'profile'; item: Profile | null } | { kind: 'skill'; item: Skill | null } | null

const TABS = [
  { id: 'profiles', label: msg('Profiles') },
  { id: 'skills', label: msg('Skills') },
] as const

export function ProfilesPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'skills' ? 'skills' : 'profiles'
  const [editing, setEditing] = useState<Editing>(null)

  return (
    <div className="mx-auto max-w-4xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={t('Profiles & Skills')} />
      <p className="mb-4 max-w-2xl text-[13px] text-muted">
        {t('Profiles are agent setups you pick in the chat. Skills are instructions you start a message with (type / in the chat), or that agents load when a task needs them.')}
        </p>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label={t('Section')}>
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              onClick={() => setParams(item.id === 'profiles' ? {} : { tab: item.id }, { replace: true })}
              className={cn('h-8 rounded-md px-3 text-[13px] font-medium transition-colors pointer-coarse:h-10',
                tab === item.id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {t(item.label)}
            </button>
          ))}
        </div>
        <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(tab === 'profiles' ? { kind: 'profile', item: null } : { kind: 'skill', item: null })}>
          {tab === 'profiles' ? t('New profile') : t('New skill')}
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
