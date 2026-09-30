import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useSettings } from '@/features/settings/api'
import { type Level, type PermissionSettings, type PermissionSummary, previewPermissions, usePermissionCatalog, useSavePermissions } from './api'

const GROUP_TONE: Record<string, string> = {
  allowed: 'text-success',
  partly: 'text-accent',
  ask: 'text-warning',
  never: 'text-error',
}

function PermissionsForm({ initial }: { initial: PermissionSettings }) {
  const catalog = usePermissionCatalog()
  const save = useSavePermissions()
  const [form, setForm] = useState<PermissionSettings>(initial)
  const [preview, setPreview] = useState<PermissionSummary | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  // Show the effective result (including the ceiling) as the user edits.
  useEffect(() => {
    const t = window.setTimeout(() => {
      previewPermissions(form).then(setPreview, () => undefined)
    }, 250)
    return () => window.clearTimeout(t)
  }, [form])

  const levels = catalog.data?.levels ?? []
  const byCap = Object.fromEntries((preview?.items ?? []).map((i) => [i.capability, i]))
  const setLevel = (cap: string, level: Level) => setForm({ ...form, levels: { ...form.levels, [cap]: level } })
  const setCeiling = (cap: string, level: Level | '') => {
    const ceiling = { ...form.ceiling }
    if (level) ceiling[cap] = level
    else delete ceiling[cap]
    setForm({ ...form, ceiling })
  }
  const limits = form.limits ?? { max_steps: 25, max_tool_calls: 100, max_runtime_s: 1800 }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="What agents may do"
          description="Applies to every agent run, including scheduled ones later. Chat mode never uses tools."
        />
        <CardBody className="flex flex-col divide-y divide-border py-1">
          {catalog.data?.categories.map((cat) => {
            const item = byCap[cat.capability]
            const level = (form.levels?.[cat.capability] as Level | undefined) ?? cat.default_level
            return (
              <div key={cat.capability} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <div className="min-w-48 flex-1">
                  <div className="text-[13.5px] font-medium">
                    {cat.label}
                    {item && !item.available && (
                      <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-subtle">no tools yet</span>
                    )}
                  </div>
                  <div className="text-[12px] text-muted">{cat.description}</div>
                  {item && item.level !== level && (
                    <div className="text-[12px] text-warning">Limited by the ceiling to “{item.level_label}”</div>
                  )}
                </div>
                <Select
                  aria-label={`${cat.label} level`}
                  className="w-56"
                  value={level}
                  onChange={(e) => setLevel(cat.capability, e.target.value as Level)}
                >
                  {levels
                    .filter((l) => cat.workspace_scoped || l.level !== 'workspace')
                    .map((l) => (
                      <option key={l.level} value={l.level}>{l.label}</option>
                    ))}
                </Select>
                {item && <span className={`w-20 text-right text-[12px] ${GROUP_TONE[item.group]}`}>{item.group === 'partly' ? 'mostly' : item.group}</span>}
              </div>
            )
          })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Limits" description="A run stops gracefully when it reaches one of these." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Max steps">
            <Input type="number" min={1} value={limits.max_steps}
              onChange={(e) => setForm({ ...form, limits: { ...limits, max_steps: Number(e.target.value) } })} />
          </Field>
          <Field label="Max tool calls">
            <Input type="number" min={1} value={limits.max_tool_calls}
              onChange={(e) => setForm({ ...form, limits: { ...limits, max_tool_calls: Number(e.target.value) } })} />
          </Field>
          <Field label="Max minutes">
            <Input type="number" min={1} value={Math.round(limits.max_runtime_s / 60)}
              onChange={(e) => setForm({ ...form, limits: { ...limits, max_runtime_s: Number(e.target.value) * 60 } })} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <details>
          <summary className="cursor-pointer px-6 py-4 text-[15px] font-semibold">Advanced: ceiling</summary>
          <CardBody className="pt-0">
            <p className="mb-3 text-[13px] text-muted">
              The ceiling is the most autonomy anything may ever get, even if an agent profile or automation
              asks for more. “Allow for this run” approvals cannot go beyond it either.
            </p>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {catalog.data?.categories.map((cat) => (
                <label key={cat.capability} className="flex items-center justify-between gap-3 text-[13px]">
                  {cat.label}
                  <Select className="h-8 w-48 text-[12.5px]" aria-label={`${cat.label} ceiling`}
                    value={(form.ceiling?.[cat.capability] as string | undefined) ?? ''}
                    onChange={(e) => setCeiling(cat.capability, e.target.value as Level | '')}>
                    <option value="">No limit</option>
                    {levels.filter((l) => cat.workspace_scoped || l.level !== 'workspace').map((l) => (
                      <option key={l.level} value={l.level}>{l.label}</option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          </CardBody>
        </details>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
          Save permissions
        </Button>
        {dirty && <Button variant="ghost" onClick={() => setForm(initial)}>Discard</Button>}
        {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
        {save.isSuccess && !dirty && <span className="text-[13px] text-success">Saved. New runs use these settings.</span>}
      </div>
    </div>
  )
}

export function PermissionsPage() {
  const settings = useSettings()
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Agent Permissions</h2>
          <p className="text-[13px] text-muted">
            Enforced by the server for every tool call, whatever the model says. Runs that are already going keep the
            permissions they started with.
          </p>
        </div>
      </div>
      {settings.data && (
        <PermissionsForm key={JSON.stringify(settings.data.permissions)} initial={settings.data.permissions} />
      )}
    </div>
  )
}
