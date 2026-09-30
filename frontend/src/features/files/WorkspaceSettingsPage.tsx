import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Folder, HardDrive, TerminalSquare } from 'lucide-react'
import { Link } from 'react-router'
import { api, errorMessage, type Schemas, unwrap } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { withReauth } from '@/features/auth/reauthStore'
import { settingsKey, useSettings } from '@/features/settings/api'
import { useFolder } from './api'

type WorkspaceSettings = Schemas['WorkspaceSettings']
type Access = WorkspaceSettings['default_agent_access']

const ACCESS_LABELS: Record<Access, string> = {
  read_write: 'Read and change',
  read: 'Read only',
  none: 'Hidden from agents',
}

const ACCESS_OPTIONS = Object.entries(ACCESS_LABELS).map(([value, label]) => ({ value, label }))

function WorkspaceForm({ initial }: { initial: WorkspaceSettings }) {
  const qc = useQueryClient()
  const top = useFolder('')
  const [form, setForm] = useState<WorkspaceSettings>(initial)
  const save = useMutation({
    mutationFn: (body: WorkspaceSettings) =>
      withReauth(async () => unwrap(await api.PUT('/api/settings/workspace', { body }))),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  })
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const restricted =
    form.default_agent_access !== 'read_write' || Object.values(form.folders ?? {}).some((a) => a !== 'read_write')
  const folders = (top.data?.entries ?? []).filter((e) => e.is_dir)

  const setFolder = (name: string, value: Access | '') => {
    const next = { ...form.folders }
    if (value) next[name] = value
    else delete next[name]
    setForm({ ...form, folders: next })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Agent access by folder"
          description="What agents may do in each top-level folder of the workspace. This is enforced on top of Agent Permissions: a hidden folder stays hidden even if file access is fully autonomous. You always see everything in Files."
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2.5">
            <span className="flex items-center gap-2 text-[13.5px] font-medium">
              <HardDrive className="h-4 w-4 text-muted" /> Default for folders not listed below
            </span>
            <Select className="w-56" aria-label="Default access" value={form.default_agent_access}
              onValueChange={(v) => setForm({ ...form, default_agent_access: v as Access })}
              options={ACCESS_OPTIONS} />
          </div>
          {folders.length === 0 && (
            <p className="text-[13px] text-muted">The workspace has no folders yet. Create some in Files.</p>
          )}
          {folders.map((f) => (
            <div key={f.path} className="flex flex-wrap items-center justify-between gap-3 px-3 py-1">
              <span className="flex items-center gap-2 text-[13.5px]">
                <Folder className="h-4 w-4 fill-accent/20 text-accent" /> {f.name}
              </span>
              <Select className="w-56" aria-label={`Access for ${f.name}`} value={form.folders?.[f.name] ?? ''}
                onValueChange={(v) => setFolder(f.name, v as Access | '')}
                options={[
                  { value: '', label: `Default (${ACCESS_LABELS[form.default_agent_access]})` },
                  ...ACCESS_OPTIONS,
                ]} />
            </div>
          ))}
          {restricted && (
            <div className="flex gap-2.5 rounded-control border border-warning/40 bg-warning/8 px-3 py-2.5 text-[13px]">
              <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p>
                Shell commands can only <em>start</em> in folders agents may change, but a running command
                can still reach every folder in the workspace. If a folder must stay private, set{' '}
                <Link to="/settings/permissions" className="text-accent underline">Run shell commands</Link> to
                Never, or keep that folder outside the workspace.
              </p>
            </div>
          )}
        </CardBody>
      </Card>
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
          Save
        </Button>
        {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
        {save.isSuccess && !dirty && <span className="text-[13px] text-success">Saved. New agent runs use these settings.</span>}
      </div>
    </div>
  )
}

export function WorkspaceSettingsPage() {
  const settings = useSettings()
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Workspace</h2>
        <p className="text-[13px] text-muted">
          The workspace is the folder mounted from your server (WORKSPACE_PATH). Agents, the file manager and your
          own tools on the server all see the same files.
        </p>
      </div>
      {settings.data && <WorkspaceForm key={JSON.stringify(settings.data.workspace)} initial={settings.data.workspace} />}
    </div>
  )
}
