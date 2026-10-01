import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { usePermissionCatalog } from '@/features/agents/api'
import { type Skill, type SkillInput, useSaveSkill } from '../api'

// Every field set (the API type marks fields with defaults as optional).
type Form = Required<SkillInput>

const EMPTY: Form = {
  slug: null,
  name: '',
  description: '',
  instructions: '',
  required_capabilities: [],
  tags: [],
  enabled: true,
}

/** Create or edit a skill. `skill` null: a new one. */
export function SkillDialog({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const save = useSaveSkill()
  const catalog = usePermissionCatalog()
  const [form, setForm] = useState<Form>(() =>
    skill
      ? {
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          required_capabilities: skill.required_capabilities,
          tags: skill.tags,
          enabled: skill.enabled,
        }
      : EMPTY,
  )
  const [tags, setTags] = useState(form.tags.join(', '))
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })
  const toggleCap = (cap: string, on: boolean) =>
    set({ required_capabilities: on ? [...form.required_capabilities, cap] : form.required_capabilities.filter((c) => c !== cap) })

  const submit = () => {
    const body = { ...form, slug: form.slug?.trim() || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }
    save.mutate({ id: skill?.id, body }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,720px)]"
      title={skill ? `Edit “${skill.name}”` : 'New skill'}
      description="Instructions an agent loads when a task needs them. Only the name and description are in its context until then."
      footer={
        <>
          {save.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim() || !form.description.trim()} onClick={submit}>
            {skill ? 'Save' : 'Create skill'}
          </Button>
        </>
      }>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} maxLength={100} placeholder="e.g. Release notes" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Short name" hint="What the agent calls it. Lowercase, digits and dashes.">
          <Input value={form.slug ?? ''} maxLength={64} placeholder="Made from the name"
            onChange={(e) => set({ slug: e.target.value.toLowerCase() })} className="font-mono" />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="When to use it" hint="The agent decides from this description whether to load the skill.">
          <Input value={form.description} maxLength={500} placeholder="Write release notes from a list of merged changes."
            onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Instructions (Markdown)">
          <Textarea rows={12} value={form.instructions} maxLength={100_000} className="font-mono text-[12.5px]"
            placeholder={'# Steps\n1. …'} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Tags" hint="Comma-separated, optional">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="writing, git" />
        </Field>
      </div>
      <div className="mt-4">
        <div className="mb-1.5 text-[13px] font-medium">Needs these permissions</div>
        <p className="mb-2 text-[12px] text-muted">Only a reminder: you are warned when one is set to Never. Permissions still decide what the agent may do.</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {catalog.data?.categories.map((cat) => (
            <label key={cat.capability} className="flex items-center gap-2 rounded-control px-2 py-1 text-[13px] hover:bg-surface-hover">
              <input type="checkbox" className="accent-[var(--accent)]" checked={form.required_capabilities.includes(cat.capability)}
                onChange={(e) => toggleCap(cat.capability, e.target.checked)} />
              {cat.label}
            </label>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-[13px]">
        <span>Enabled</span>
        <Switch label="Enabled" checked={form.enabled} onChange={(enabled) => set({ enabled })} />
      </div>
    </Dialog>
  )
}
