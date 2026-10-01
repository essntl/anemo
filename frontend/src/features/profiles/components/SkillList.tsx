import { useRef } from 'react'
import { AlertTriangle, BookOpen, Download, Pencil, Trash2, Upload } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Switch } from '@/components/ui/Switch'
import { usePermissionCatalog } from '@/features/agents/api'
import { type Skill, skillExportUrl, useDeleteSkill, useImportSkill, useSaveSkill, useSkills } from '../api'

export function SkillList({ onEdit }: { onEdit: (skill: Skill) => void }) {
  const skills = useSkills()
  const save = useSaveSkill()
  const remove = useDeleteSkill()
  const importSkill = useImportSkill()
  const catalog = usePermissionCatalog()
  const fileRef = useRef<HTMLInputElement>(null)
  const capLabel = (cap: string) => catalog.data?.categories.find((c) => c.capability === cap)?.label ?? cap
  const error = save.error ?? remove.error ?? importSkill.error

  // Import SKILL.md-style files; asks before replacing a skill with the same short name.
  const onFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const content = await file.text()
      try {
        await importSkill.mutateAsync({ content })
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'skill_exists')) continue
        const ok = await confirmDialog({ title: 'Replace skill?', message: `${err.message} Replace it with ${file.name}?`, confirmLabel: 'Replace' })
        if (ok) await importSkill.mutateAsync({ content, replace: true }).catch(() => undefined)
      }
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const toggle = (s: Skill, enabled: boolean) =>
    save.mutate({ id: s.id, body: { slug: s.slug, name: s.name, description: s.description, instructions: s.instructions,
      required_capabilities: s.required_capabilities, tags: s.tags, enabled } })

  const confirmDelete = async (s: Skill) => {
    if (await confirmDialog({ title: `Delete “${s.name}”?`, message: 'Profiles that use it will no longer offer it.', confirmLabel: 'Delete', danger: true })) {
      remove.mutate(s.id)
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
        <Button size="sm" variant="secondary" icon={<Upload className="h-3.5 w-3.5" />} loading={importSkill.isPending}
          onClick={() => fileRef.current?.click()}>
          Import .md
        </Button>
        <span className="text-[12px] text-muted">SKILL.md files with a name and description at the top work as they are.</span>
      </div>
      {error && !(error instanceof ApiError && error.code === 'skill_exists') && (
        <p className="mb-2 text-[13px] text-error">{errorMessage(error)}</p>
      )}
      {skills.isSuccess && skills.data.length === 0 && (
        <EmptyState icon={<BookOpen className="h-5 w-5" />} title="No skills yet"
          description="A skill is a set of instructions for one kind of task, such as writing release notes. Agents see its description and load it when it fits." />
      )}
      <div className="flex flex-col gap-2">
        {skills.data?.map((s) => (
          <div key={s.id} className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3 shadow-soft">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onEdit(s)}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium">{s.name}</span>
                <code className="font-mono text-[11.5px] text-subtle">{s.slug}</code>
                {s.tags.map((t) => <Badge key={t}>{t}</Badge>)}
              </div>
              <div className="text-[12.5px] text-muted">{s.description}</div>
              {s.blocked_capabilities.length > 0 && (
                <div className="mt-1 flex items-center gap-1 text-[12px] text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Needs {s.blocked_capabilities.map(capLabel).join(', ')}, which your permissions set to Never.
                </div>
              )}
            </button>
            <Switch label={`${s.name} enabled`} checked={s.enabled} onChange={(on) => toggle(s, on)} />
            <ActionMenu actions={[
              { label: 'Edit', icon: <Pencil />, onSelect: () => onEdit(s) },
              { label: 'Export .md', icon: <Download />, download: skillExportUrl(s.id) },
              { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete(s) },
            ]} />
          </div>
        ))}
      </div>
    </div>
  )
}
