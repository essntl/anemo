import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Folder, HardDrive } from 'lucide-react'
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
          <label className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2.5">
            <span className="flex items-center gap-2 text-[13.5px] font-medium">
              <HardDrive className="h-4 w-4 text-muted" /> Default for folders not listed below
            </span>
            <Select className="w-56" value={form.default_agent_access}
              onChange={(e) => setForm({ ...form, default_agent_access: e.target.value as Access })}>
              {Object.entries(ACCESS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </label>
          {folders.length === 0 && (
            <p className="text-[13px] text-muted">The workspace has no folders yet. Create some in Files.</p>
          )}
          {folders.map((f) => (
            <label key={f.path} className="flex flex-wrap items-center justify-between gap-3 px-3 py-1">
              <span className="flex items-center gap-2 text-[13.5px]">
                <Folder className="h-4 w-4 fill-accent/20 text-accent" /> {f.name}
              </span>
              <Select className="w-56" value={form.folders?.[f.name] ?? ''}
                onChange={(e) => setFolder(f.name, e.target.value as Access | '')}>
                <option value="">Default ({ACCESS_LABELS[form.default_agent_access]})</option>
                {Object.entries(ACCESS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </label>
          ))}
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
