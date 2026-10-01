import { type ReactNode, useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { LimitsFields } from '@/features/agents/components/LimitsFields'
import { DEFAULT_LIMITS } from '@/features/agents/limits'
import { useModels } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'
import { type Profile, type ProfileInput, useSaveProfile, useSkills } from '../api'
import { ProfilePermissions } from './ProfilePermissions'

// Every field set (the API type marks fields with defaults as optional).
type Form = Required<ProfileInput>

const EMPTY: Form = {
  name: '',
  description: '',
  instructions: '',
  icon: 'bot',
  default_model_id: null,
  permission_levels: {},
  limits: null,
  plan_review: null,
  skill_mode: 'all',
  skill_ids: [],
}

/** The editable fields of a saved profile. */
const pick = (p: Profile): Form => ({
  name: p.name,
  description: p.description,
  instructions: p.instructions,
  icon: p.icon,
  default_model_id: p.default_model_id,
  permission_levels: p.permission_levels,
  limits: p.limits,
  plan_review: p.plan_review,
  skill_mode: p.skill_mode,
  skill_ids: p.skill_ids,
})

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="text-[13.5px] font-semibold">{title}</h3>
      {hint && <p className="mb-2 text-[12px] text-muted">{hint}</p>}
      {children}
    </section>
  )
}

/** Create or edit an agent profile. `profile` null: a new one. */
export function ProfileDialog({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const save = useSaveProfile()
  const models = useModels()
  const skills = useSkills()
  const settings = useSettings()
  const [form, setForm] = useState<Form>(() => (profile ? pick(profile) : EMPTY))
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })
  const globalLimits = settings.data?.permissions.limits ?? DEFAULT_LIMITS
  const usable = (models.data ?? []).filter((m) => m.enabled && m.provider_enabled && m.capabilities.tools)

  const submit = () => save.mutate({ id: profile?.id, body: form }, { onSuccess: onClose })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,680px)]"
      title={profile ? `Edit “${profile.name}”` : 'New agent profile'}
      description="A named agent setup: its instructions, model, permissions and skills."
      footer={
        <>
          {save.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim()} onClick={submit}>
            {profile ? 'Save' : 'Create profile'}
          </Button>
        </>
      }>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} maxLength={100} placeholder="e.g. Researcher" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Model" hint="The chat's model picker still wins when set">
          <Select value={form.default_model_id ?? ''} onValueChange={(v) => set({ default_model_id: v || null })}
            options={[{ value: '', label: 'Agent default (Settings)' }, ...usable.map((m) => ({ value: m.id, label: m.display_name }))]} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Description">
          <Input value={form.description} maxLength={500} placeholder="What this agent is for"
            onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Instructions" hint="Added to the agent's system prompt: role, style, rules, context about you.">
          <Textarea rows={6} value={form.instructions} maxLength={50_000}
            placeholder="You research topics thoroughly and cite your sources…"
            onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
      </div>

      <Section title="Permissions" hint="Override the global permissions for runs with this profile. Changing them asks for your password.">
        <ProfilePermissions value={form.permission_levels} onChange={(permission_levels) => set({ permission_levels })} />
      </Section>

      <Section title="Plan review">
        <Select value={form.plan_review ?? ''} onValueChange={(v) => set({ plan_review: (v || null) as ProfileInput['plan_review'] })}
          options={[
            { value: '', label: `Same as Settings (${settings.data?.permissions.plan_review === 'always' ? 'review first' : 'off'})` },
            { value: 'always', label: 'Review the plan before it acts' },
            { value: 'off', label: 'No plan review' },
          ]} />
      </Section>

      <Section title="Limits">
        <div className="mb-3 flex items-center justify-between gap-3 text-[13px]">
          <span>Use custom limits for this profile</span>
          <Switch label="Custom limits" checked={form.limits != null}
            onChange={(on) => set({ limits: on ? { ...DEFAULT_LIMITS, ...globalLimits } : null })} />
        </div>
        {form.limits && <LimitsFields value={form.limits} onChange={(limits) => set({ limits })} />}
      </Section>

      <Section title="Skills" hint="Skills the agent can load when a task calls for them.">
        <Select value={form.skill_mode} onValueChange={(v) => set({ skill_mode: v as ProfileInput['skill_mode'] })}
          options={[
            { value: 'all', label: 'All enabled skills' },
            { value: 'selected', label: 'Only the skills selected below' },
            { value: 'none', label: 'No skills' },
          ]} />
        {form.skill_mode === 'selected' && (
          <div className="mt-2 flex flex-col gap-1">
            {(skills.data ?? []).map((s) => (
              <label key={s.id} className="flex items-start gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover">
                <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={form.skill_ids.includes(s.id)}
                  onChange={(e) => set({ skill_ids: e.target.checked ? [...form.skill_ids, s.id] : form.skill_ids.filter((id) => id !== s.id) })} />
                <span>
                  <span className="font-medium">{s.name}</span>
                  {!s.enabled && <span className="text-subtle"> (disabled)</span>}
                  <span className="block text-[12px] text-muted">{s.description}</span>
                </span>
              </label>
            ))}
            {skills.data?.length === 0 && <p className="text-[12.5px] text-muted">No skills yet. Add some on the Skills tab.</p>}
          </div>
        )}
      </Section>
    </Dialog>
  )
}
