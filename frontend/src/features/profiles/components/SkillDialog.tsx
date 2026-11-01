import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { usePermissionCatalog } from '@/features/agents/api'
import { SkillIcon } from '@/features/skills/icons'
import { SKILL_ICON_NAMES } from '@/features/skills/iconMap'
import { cn } from '@/lib/cn'
import { type Skill, type SkillInput, skillBody, useSaveSkill } from '../api'

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
  icon: 'sparkles',
  hint: '',
  user_invocable: true,
  model_invocable: true,
  mode: 'any',
}

const INSTRUCTIONS_PLACEHOLDER = `What the assistant should do when this skill is used, e.g.

Explain the topic in the user's message step by step.
1. Start with a one-sentence summary.
2. Give a concrete example.
3. End with one question that checks understanding.`

function Toggle({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[13px]">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-[12px] text-muted">{hint}</div>
      </div>
      <Switch label={title} checked={checked} onChange={onChange} />
    </div>
  )
}

/** Create or edit a skill. `skill` null: a new one. */
export function SkillDialog({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const save = useSaveSkill()
  const catalog = usePermissionCatalog()
  const [form, setForm] = useState<Form>(() => (skill ? skillBody(skill) : EMPTY))
  const [tags, setTags] = useState(form.tags.join(', '))
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })
  const toggleCap = (cap: string, on: boolean) =>
    set({ required_capabilities: on ? [...form.required_capabilities, cap] : form.required_capabilities.filter((c) => c !== cap) })
  const command = form.slug?.trim() || form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'name'

  const submit = () => {
    const body = { ...form, slug: form.slug?.trim() || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }
    save.mutate({ id: skill?.id, body }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,720px)]"
      title={skill ? `Edit “${skill.name}”` : 'New skill'}
      description={
        <>Instructions for one kind of task. Start a message with <code className="font-mono">/{command}</code> to use it, or let agents load it when a task needs it.</>
      }
      footer={
        <>
          {save.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim() || !form.description.trim()} onClick={submit}>
            {skill ? 'Save' : 'Create skill'}
          </Button>
        </>
      }>
      {skill?.builtin && (
        <p className="mb-4 rounded-control bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
          A built-in skill. Once you change it, it is yours: new versions of Anemo no longer update it. “Reset” in its menu brings back the original.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} maxLength={100} placeholder="e.g. Study" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Command" hint="What you type after /. Lowercase, digits and dashes.">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[13px] text-subtle">/</span>
            <Input value={form.slug ?? ''} maxLength={64} placeholder="Made from the name"
              onChange={(e) => set({ slug: e.target.value.toLowerCase() })} className="pl-6 font-mono" />
          </div>
        </Field>
      </div>
      <div className="mt-4">
        <div className="mb-1.5 text-[13px] font-medium">Icon</div>
        <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
          {SKILL_ICON_NAMES.map((name) => (
            <button key={name} type="button" role="radio" aria-checked={form.icon === name} aria-label={name} title={name}
              onClick={() => set({ icon: name })}
              className={cn('flex h-8 w-8 items-center justify-center rounded-control border transition-colors pointer-coarse:h-10 pointer-coarse:w-10',
                form.icon === name ? 'border-accent bg-accent-soft text-accent' : 'border-transparent text-muted hover:bg-surface-hover hover:text-text')}>
              <SkillIcon name={name} />
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Hint" hint="Shown in the message box while the skill is chosen.">
          <Input value={form.hint} maxLength={120} placeholder="e.g. Learn a new concept" onChange={(e) => set({ hint: e.target.value })} />
        </Field>
        <Field label="Tags" hint="Comma-separated, optional">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="learning, writing" />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Description" hint="Shown in the / menu. Agents also decide from it whether to load the skill.">
          <Input value={form.description} maxLength={500} placeholder="Learn a concept step by step, with practice tasks."
            onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Instructions (Markdown)" hint="Given to the model with the message you start with this skill.">
          <Textarea rows={12} value={form.instructions} maxLength={100_000} className="font-mono text-[12.5px]"
            placeholder={INSTRUCTIONS_PLACEHOLDER} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
      </div>

      <div className="mt-5 flex flex-col gap-4 border-t border-border pt-4">
        <Toggle title="Enabled" hint="Off: not offered anywhere." checked={form.enabled} onChange={(enabled) => set({ enabled })} />
        <Toggle title={`Use as /${command} in the chat`} hint="Offered in the menu that opens when you type / in the message box."
          checked={form.user_invocable} onChange={(user_invocable) => set({ user_invocable })} />
        <Toggle title="Switch to Agent mode" hint="For skills that need tools, such as web search or files. You can still switch back before sending."
          checked={form.mode === 'agent'} onChange={(on) => set({ mode: on ? 'agent' : 'any' })} />
        <Toggle title="Agents may load it by themselves" hint="Agents see its description and load it when a task fits."
          checked={form.model_invocable} onChange={(model_invocable) => set({ model_invocable })} />
      </div>

      <div className="mt-5">
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
    </Dialog>
  )
}
