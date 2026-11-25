/**
 * Installing a plugin: from a zip file, a Git address or the examples that come with Anemo,
 * then at once the review of what was installed (contract §5: install → needs review →
 * approve). The same flow brings a new version of an installed plugin: it is stored as
 * pending and reviewed here, while the approved one keeps running.
 */
import { type DragEvent, useRef, useState } from 'react'
import { FileArchive, GitBranch, Upload } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/format'
import { t } from '@/lib/i18n'
import { type InstallRequest, useBundledPlugins, useInstallPlugin } from '../api'
import { highestRisk, RISK_GROUPS, RISK_LABELS } from '../permissions'
import { PluginIcon } from '../PluginIcon'
import type { PluginDetailOut } from '../types'
import { VersionReview } from './Review'

type Tab = 'zip' | 'git' | 'examples'

/**
 * Why an install was refused. A package that breaks the rules (`plugin_invalid`) comes with
 * the list of problems, file by file, so the author can fix them.
 */
function InstallError({ error }: { error: Error }) {
  const details = error instanceof ApiError ? (error.details as { errors?: { path?: string; message?: string }[] } | undefined) : undefined
  const problems = details?.errors ?? []
  return (
    <div role="alert" className="break-words text-[12.5px] text-error">
      <p>{errorMessage(error)}</p>
      {problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {problems.slice(0, 20).map((p, i) => <li key={i}>{p.path && <code className="font-mono">{p.path}</code>}{p.path && ': '}{p.message}</li>)}
        </ul>
      )}
    </div>
  )
}

/** The version to review after an install: the pending one (null when nothing new came in). */
function pendingOf(detail: PluginDetailOut) {
  return detail.versions.find((v) => v.status === 'pending') ?? null
}

function ZipPicker({ onPick, busy }: { onPick: (file: File) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const take = (picked: File | undefined) => {
    if (!picked) return
    setFile(picked)
    onPick(picked)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    take(e.dataTransfer.files[0])
  }
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn('flex flex-col items-center gap-2 rounded-card border border-dashed px-4 py-8 text-center transition-colors',
        over ? 'border-accent bg-accent-soft' : 'border-border-strong')}
    >
      <FileArchive className="h-6 w-6 text-accent" />
      <p className="text-[13.5px] font-medium">{t('Drop a plugin’s .zip file here')}</p>
      <p className="text-[12.5px] text-muted">{t('A folder with anemo-plugin.json at its root, compressed. Up to 5 MB unpacked.')}</p>
      <input ref={input} type="file" accept=".zip,application/zip" className="sr-only" aria-label={t('Choose a .zip file')}
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
      <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={busy} onClick={() => input.current?.click()}>
        {t('Choose a file')}
      </Button>
      {file && <p className="text-[12px] text-muted">{file.name} · {formatSize(file.size)}</p>}
    </div>
  )
}

function GitForm({ onInstall, busy }: { onInstall: (url: string, ref: string) => void; busy: boolean }) {
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const valid = /^https:\/\/\S+$/.test(url.trim())
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (valid) onInstall(url.trim(), ref.trim()) }}>
      <Field label={t('Repository address')} hint={t('A public repository, over https. It is fetched without any of your credentials.')}>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/anemo-plugin" inputMode="url" autoComplete="off" />
      </Field>
      <Field label={t('Branch, tag or commit (optional)')}>
        <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" autoComplete="off" />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" icon={<GitBranch className="h-4 w-4" />} disabled={!valid} loading={busy}>{t('Install')}</Button>
      </div>
    </form>
  )
}

/** The examples that come with Anemo, each one click away from its review. */
export function BundledList({ onInstall, busyId }: { onInstall: (id: string) => void; busyId: string | null }) {
  const bundled = useBundledPlugins()
  if (bundled.isError) return <p className="text-[12.5px] text-error">{errorMessage(bundled.error)}</p>
  if (!bundled.data) return <p className="text-[13px] text-muted">{t('Loading…')}</p>
  if (bundled.data.length === 0) return <p className="text-[13px] text-muted">{t('No examples in this version of Anemo.')}</p>
  return (
    <ul className="flex flex-col divide-y divide-border text-left">
      {bundled.data.map((p) => (
        <li key={p.id} className="flex items-center gap-3 py-(--item-y)">
          <PluginIcon url={null} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
              {p.name} <span className="font-normal text-subtle">{p.version}</span>
              {/* How far it reaches: the riskiest permission it asks for. */}
              {highestRisk(p.permissions) && <Badge tone={RISK_GROUPS[highestRisk(p.permissions)!].tone}>{t(RISK_LABELS[highestRisk(p.permissions)!])}</Badge>}
            </div>
            <p className="line-clamp-2 text-[12.5px] text-muted">{p.description}</p>
          </div>
          <Button size="sm" disabled={p.installed || (busyId !== null && busyId !== p.id)} loading={busyId === p.id} onClick={() => onInstall(p.id)}>
            {p.installed ? t('Installed') : t('Install')}
          </Button>
        </li>
      ))}
    </ul>
  )
}

export function InstallDialog({ onClose, onOpen, start }: {
  onClose: () => void
  /** Go to the plugin's page (after an install that had nothing new to review). */
  onOpen: (id: string) => void
  /** Open right on a step: an example being installed from the empty list. */
  start?: { tab?: Tab; installed?: PluginDetailOut }
}) {
  const [tab, setTab] = useState<Tab>(start?.tab ?? 'zip')
  const [installed, setInstalled] = useState<PluginDetailOut | null>(start?.installed ?? null)
  const install = useInstallPlugin()
  const run = (request: InstallRequest) => install.mutate(request, { onSuccess: setInstalled })
  const busyId = install.isPending && install.variables?.kind === 'bundled' ? install.variables.id : null

  const pending = installed ? pendingOf(installed) : null
  if (installed) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(96vw,680px)]"
        title={pending ? t('Review “{name}”', { name: installed.name }) : t('“{name}” is installed', { name: installed.name })}
        description={pending ? t('Version {version}. Check what it may do before you turn it on.', { version: pending.version }) : undefined}>
        <div className="mb-4 flex items-center gap-3">
          <PluginIcon url={installed.icon_url} size={44} />
          <div className="min-w-0">
            <div className="font-semibold">{installed.name}</div>
            <p className="line-clamp-2 text-[12.5px] text-muted">{installed.description}</p>
          </div>
        </div>
        {pending ? (
          <VersionReview plugin={installed} version={pending} onClose={onClose} onDone={onClose} />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted">{t('These exact files are installed already, so there is nothing new to review.')}</p>
            <div className="flex justify-end"><Button variant="primary" onClick={() => onOpen(installed.id)}>{t('Open')}</Button></div>
          </div>
        )}
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(96vw,560px)]"
      title={t('Install a plugin')}
      description={t('Nothing of it runs until you have reviewed and approved it.')}>
      <div className="flex flex-col gap-4">
        <Segmented kind="tabs" label={t('Install from')} value={tab} onChange={setTab} controls="install" className="self-start"
          options={[{ value: 'zip', label: t('Zip file') }, { value: 'git', label: t('Git address') }, { value: 'examples', label: t('Examples') }]} />
        <div id={`install-${tab}`} role="tabpanel">
          {tab === 'zip' && <ZipPicker busy={install.isPending} onPick={(file) => run({ kind: 'zip', file })} />}
          {tab === 'git' && <GitForm busy={install.isPending} onInstall={(url, ref) => run({ kind: 'git', url, ref })} />}
          {tab === 'examples' && <BundledList busyId={busyId} onInstall={(id) => run({ kind: 'bundled', id })} />}
        </div>
        {install.isError && <InstallError error={install.error} />}
      </div>
    </Dialog>
  )
}
