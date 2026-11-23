/**
 * New job (docs/specs/code-sessions.md §12.4): a computer that lets Anemo start Claude
 * Code jobs, a project (its folders first, then its owner's repositories not cloned
 * yet; any name may be typed), "New project" when the name matches none, the prompt
 * and the model. The started job opens at /code/<id>, followed live.
 */
import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { msg, t } from '@/lib/i18n'
import { type CodeDevice, type CodeModel, useCodeDevices, useCodeProjects, useStartJob } from './api'
import { knownProject, validProjectName } from './projects'

const MODELS: { value: '' | CodeModel; label: string }[] = [
  { value: '', label: msg('Default') },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export function NewJobDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const listId = useId()
  const devices = useCodeDevices(open)
  const usable = useMemo(() => (devices.data ?? []).filter((d) => d.online && d.start), [devices.data])
  // The computer picked in the list (kept as it was, should it leave the list).
  const [picked, setPicked] = useState<CodeDevice | null>(null)
  const [project, setProject] = useState('')
  const [isNew, setNew] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<'' | CodeModel>('')
  const start = useStartJob()

  // The first computer that can start jobs, until one is chosen.
  // The list is fetched again on every code.job notice: a picked computer that stops
  // being usable stays picked (Start is off, one line says why); never another one.
  const current = picked ? (devices.data ?? []).find((d) => d.id === picked.id) : undefined
  const device = picked ? (current ?? picked) : usable[0]
  const usableNow = Boolean(device && usable.some((d) => d.id === device.id))
  const why = !picked || usableNow ? null
    : !current ? t('{device} is no longer one of your trusted computers.', { device: picked.name })
      : !current.online ? t('{device} is offline now.', { device: current.name })
        : t('{device} doesn’t let Anemo start jobs right now.', { device: current.name })
  const projects = useCodeProjects(open && device && usableNow ? device.id : null)
  // The usable computers, and the picked one wherever it went.
  const choices = picked && !usable.some((d) => d.id === picked.id) ? [...usable, device ?? picked] : usable

  const name = project.trim()
  // "New project" only means something for a name the computer can't resolve (§12.1, §12.5).
  const offerNew = name !== '' && validProjectName(name) && projects.isSuccess && !knownProject(projects.data, name)
  const badName = name !== '' && !validProjectName(name)
  const ready = Boolean(device) && usableNow && validProjectName(name) && prompt.trim() !== '' && !start.isPending

  const submit = () => {
    if (!ready || !device) return
    start.mutate(
      { device_id: device.id, project: name, prompt: prompt.trim(), new: offerNew && isNew, model: model || null },
      {
        onSuccess: (job) => {
          onOpenChange(false)
          setProject('')
          setPrompt('')
          setNew(false)
          void navigate(`/code/${job.id}`)
        },
        onError: (err) => toast({ message: errorMessage(err) }),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('New Claude Code job')} className="md:w-[min(92vw,560px)]"
      description={t('Claude Code runs on the computer with every permission (bypassPermissions), in the project’s folder.')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
          <Button variant="primary" loading={start.isPending} disabled={!ready} onClick={submit}>{t('Start job')}</Button>
        </>
      }>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        {devices.isError ? (
          <p className="text-[13px] text-error">{errorMessage(devices.error)}</p>
        ) : devices.isSuccess && usable.length === 0 && !picked ? (
          <p data-testid="no-start-device" className="rounded-lg bg-surface-2 p-3 text-[13px] text-muted">
            {t('No computer lets Anemo start jobs now. In Anemo Desktop on a trusted computer, turn on “Share Claude Code jobs with Anemo” and “Let Anemo start Claude Code jobs”.')}
          </p>
        ) : (
          <Field label={t('Computer')} error={why ?? undefined}>
            <Select aria-label={t('Computer')} value={device?.id ?? ''}
              onValueChange={(v) => { setPicked(choices.find((d) => d.id === v) ?? null); setProject('') }}
              placeholder={devices.isPending ? t('Loading…') : undefined}
              options={choices.map((d) => ({ value: d.id, label: d.name }))} />
          </Field>
        )}

        <Field label={t('Project')}
          error={badName ? t('A folder name: letters, digits, dots, dashes and underscores; not a Windows device name like CON or NUL, and no dot at the end.') : projects.isError ? errorMessage(projects.error) : undefined}
          hint={projects.isFetching ? t('Asking the computer for its projects…') : projects.data?.note ?? undefined}>
          <Input value={project} onChange={(e) => setProject(e.target.value)} list={listId} autoComplete="off" spellCheck={false}
            placeholder={t('A project folder or a GitHub repository')} disabled={!device} />
        </Field>
        {/* The computer's folders first, then the repositories not cloned yet; any other name may be typed. */}
        <datalist id={listId}>
          {projects.data?.projects.map((p) => <option key={`l:${p.name}`} value={p.name} label={p.dir} />)}
          {projects.data?.remote.map((r) => <option key={`r:${r.name}`} value={r.name} label={t('On GitHub, not cloned')} />)}
        </datalist>
        {offerNew && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
            <span>
              <span className="font-medium">{t('New project')}</span>
              <span className="block text-[12px] text-muted">{t('No folder or repository has this name: create an empty one (git init).')}</span>
            </span>
            <Switch checked={isNew} onChange={setNew} label={t('New project')} />
          </div>
        )}

        <Field label={t('Prompt')}>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} maxLength={100_000}
            placeholder={t('What should Claude Code do?')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() } }} />
        </Field>

        <Field label={t('Model')}>
          <Select aria-label={t('Model')} value={model} onValueChange={(v) => setModel(v as '' | CodeModel)}
            options={MODELS.map((m) => ({ value: m.value, label: m.value ? m.label : t(m.label) }))} />
        </Field>
        {start.isPending && <p className="text-[12.5px] text-muted">{t('Starting… Cloning a repository can take a few minutes.')}</p>}
      </form>
    </Dialog>
  )
}
