import { Bot, Pencil, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { type Profile, useDeleteProfile, useProfiles } from '../api'

function describe(p: Profile): string[] {
  const facts: string[] = []
  const overrides = Object.keys(p.permission_levels).length
  if (overrides) facts.push(`${overrides} permission${overrides === 1 ? '' : 's'} changed`)
  if (p.limits) facts.push('custom limits')
  if (p.plan_review === 'always') facts.push('reviews plans')
  if (p.plan_review === 'off') facts.push('no plan review')
  facts.push(p.skill_mode === 'all' ? 'all skills' : p.skill_mode === 'none' ? 'no skills' : `${p.skill_ids.length} skills`)
  return facts
}

export function ProfileList({ onEdit }: { onEdit: (profile: Profile) => void }) {
  const profiles = useProfiles()
  const remove = useDeleteProfile()

  const confirmDelete = async (p: Profile) => {
    const ok = await confirmDialog({
      title: `Delete “${p.name}”?`,
      message: 'Past runs keep their history. Chats using this profile switch back to the default agent.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(p.id)
  }

  if (profiles.isSuccess && profiles.data.length === 0) {
    return (
      <EmptyState icon={<Bot className="h-5 w-5" />} title="No profiles yet"
        description="Without a profile, agents use your global permissions and no special instructions. Create one for a recurring kind of work, like research or coding." />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {remove.isError && <p className="text-[13px] text-error">{errorMessage(remove.error)}</p>}
      {profiles.data?.map((p) => (
        <div key={p.id} className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3 shadow-soft">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onEdit(p)}>
            <div className="text-[14px] font-medium">{p.name}</div>
            {p.description && <div className="text-[12.5px] text-muted">{p.description}</div>}
            <div className="mt-1.5 flex flex-wrap gap-1">
              {describe(p).map((f) => <Badge key={f}>{f}</Badge>)}
            </div>
          </button>
          <ActionMenu actions={[
            { label: 'Edit', icon: <Pencil />, onSelect: () => onEdit(p) },
            { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete(p) },
          ]} />
        </div>
      ))}
    </div>
  )
}
