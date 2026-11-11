import { useRef } from 'react'
import { AlertTriangle, BookOpen, Bot, Download, Pencil, RotateCcw, Trash2, Upload } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { ActionMenu, type MenuAction } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { Switch } from '@/components/ui/Switch'
import { usePermissionCatalog } from '@/features/agents/api'
import { SkillIcon } from '@/features/skills/icons'
import { t } from '@/lib/i18n'
import {
  type Skill, skillBody, skillExportUrl, useDeleteSkill, useImportSkill, useResetSkill, useSaveSkill, useSkills,
} from '../api'

function SkillRow({ skill: s, onEdit }: { skill: Skill; onEdit: () => void }) {
  const save = useSaveSkill()
  const remove = useDeleteSkill()
  const reset = useResetSkill()
  const catalog = usePermissionCatalog()
  const capLabel = (cap: string) => catalog.data?.categories.find((c) => c.capability === cap)?.label ?? cap
  const error = save.error ?? remove.error ?? reset.error

  const confirmDelete = async () => {
    if (await confirmDialog({ title: t('Delete “{name}”?', { name: s.name }), message: t('It is no longer offered as a command, and profiles that use it no longer have it.'), confirmLabel: t('Delete'), danger: true })) {
      remove.mutate(s.id)
    }
  }
  const confirmReset = async () => {
    if (await confirmDialog({ title: t('Reset “{name}”?', { name: s.name }), message: t('Your changes to its name, description and instructions are replaced by the original. Its switches stay as they are.'), confirmLabel: t('Reset') })) {
      reset.mutate(s.id)
    }
  }

  const actions: MenuAction[] = [
    { label: t('Edit'), icon: <Pencil />, onSelect: onEdit },
    { label: t('Export .md'), icon: <Download />, download: skillExportUrl(s.id) },
    ...(s.builtin
      ? s.customized ? [{ label: t('Reset to original'), icon: <RotateCcw />, onSelect: () => void confirmReset() }] : []
      : [{ label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() }]),
  ]

  return (
    <div className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3 shadow-soft">
      <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${s.enabled ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-subtle'}`}>
        <SkillIcon name={s.icon} />
      </div>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium">{s.name}</span>
          {s.user_invocable
            ? <code className="font-mono text-[12px] text-accent">/{s.slug}</code>
            : <code className="font-mono text-[11.5px] text-subtle">{s.slug}</code>}
          {s.model_invocable && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-subtle" title={t('Agents may load it by themselves')}>
              <Bot className="h-3 w-3" /> {t('agents')}
            </span>
          )}
          {s.mode === 'agent' && <Badge tone="accent">{t('Agent mode')}</Badge>}
          {s.customized && <Badge>{t('Edited')}</Badge>}
          {s.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
        </div>
        <div className="text-[12.5px] text-muted">{s.description}</div>
        {s.blocked_capabilities.length > 0 && (
          <div className="mt-1 flex items-center gap-1 text-[12px] text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('Needs {permissions}, which your permissions set to Never.', { permissions: s.blocked_capabilities.map((cap) => t(capLabel(cap))).join(', ') })}
          </div>
        )}
        {error && <p className="mt-1 text-[12px] text-error">{errorMessage(error)}</p>}
      </button>
      <Switch label={t('{name} enabled', { name: s.name })} checked={s.enabled} onChange={(enabled) => save.mutate({ id: s.id, body: { ...skillBody(s), enabled } })} />
      <ActionMenu actions={actions} />
    </div>
  )
}

export function SkillList({ onEdit }: { onEdit: (skill: Skill) => void }) {
  const skills = useSkills()
  const importSkill = useImportSkill()
  const fileRef = useRef<HTMLInputElement>(null)
  const own = skills.data?.filter((s) => !s.builtin) ?? []
  const builtin = skills.data?.filter((s) => s.builtin) ?? []

  // Import SKILL.md-style files; asks before replacing a skill with the same short name.
  const onFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const content = await file.text()
      try {
        await importSkill.mutateAsync({ content })
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'skill_exists')) continue
        const ok = await confirmDialog({ title: t('Replace skill?'), message: `${err.message} ${t('Replace it with {name}?', { name: file.name })}`, confirmLabel: t('Replace') })
        if (ok) await importSkill.mutateAsync({ content, replace: true }).catch(() => undefined)
      }
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
        <Button size="sm" variant="secondary" icon={<Upload className="h-3.5 w-3.5" />} loading={importSkill.isPending}
          onClick={() => fileRef.current?.click()}>
          {t('Import .md')}
        </Button>
        <span className="text-[12px] text-muted">{t('SKILL.md files with a name and description at the top work as they are.')}</span>
      </div>
      {importSkill.error && !(importSkill.error instanceof ApiError && importSkill.error.code === 'skill_exists') && (
        <p className="mb-2 text-[13px] text-error">{errorMessage(importSkill.error)}</p>
      )}
      {skills.isError && <p className="mb-2 text-[13px] text-error">{errorMessage(skills.error)}</p>}

      <h2 className="mb-2 mt-4 text-[13px] font-semibold text-muted">{t('Your skills')}</h2>
      {skills.isSuccess && own.length === 0 && (
        <p className="flex items-start gap-2 rounded-card border border-dashed border-border px-4 py-3 text-[12.5px] text-muted">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0" />
          {t('None yet. Write instructions for something you ask for often (release notes, a weekly review, a code review checklist) and start a message with its /command.')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {own.map((s) => <SkillRow key={s.id} skill={s} onEdit={() => onEdit(s)} />)}
      </div>

      {builtin.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-[13px] font-semibold text-muted">{t('Built in')}</h2>
          <div className="flex flex-col gap-2">
            {builtin.map((s) => <SkillRow key={s.id} skill={s} onEdit={() => onEdit(s)} />)}
          </div>
        </>
      )}
    </div>
  )
}
