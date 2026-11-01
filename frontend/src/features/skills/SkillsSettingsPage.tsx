/**
 * Settings > Skills: create, edit and switch skills on and off. A skill is used by
 * starting a message with its /command (or loaded by agents, when allowed).
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Lingering } from '@/components/ui/Lingering'
import type { Skill } from '@/features/profiles/api'
import { SkillDialog } from '@/features/profiles/components/SkillDialog'
import { SkillList } from '@/features/profiles/components/SkillList'

export function SkillsSettingsPage() {
  // undefined: no dialog; null: a new skill.
  const [editing, setEditing] = useState<Skill | null | undefined>(undefined)
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Skills</h2>
          <p className="mt-1 max-w-xl text-[13px] text-muted">
            Ready-made instructions for one kind of task. Type <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[12px]">/</kbd> in
            the message box and pick one, e.g. <code className="font-mono text-accent">/study</code> to learn a concept with practice tasks,
            or <code className="font-mono text-accent">/fact-check</code> to check a claim.
          </p>
        </div>
        <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(null)}>
          New skill
        </Button>
      </div>
      <SkillList onEdit={setEditing} />
      <Lingering value={editing !== undefined && { item: editing }}>
        {(shown) => <SkillDialog skill={shown.item} onClose={() => setEditing(undefined)} />}
      </Lingering>
    </div>
  )
}
