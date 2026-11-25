/**
 * The pieces of a plugin review, shared by the install flow and the plugin's page: its
 * permissions grouped by risk, what it adds to Anemo, where it came from, and the review of
 * a version waiting for approval (with the diff when it updates an approved one).
 */
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown, Minus, Plus, ShieldAlert } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DiffView } from '@/components/ui/DiffView'
import { chatLink } from '@/lib/appLinks'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/format'
import { msg, plural, t } from '@/lib/i18n'
import { useApproveVersion, usePluginDiff, useRejectVersion } from '../api'
import { groupByRisk, groupContributions, permissionText, READ_WARNING, readsData, RISK_GROUPS, RISK_LABELS } from '../permissions'
import type { ContributionOut, PermissionOut, PluginDetailOut, PluginDiffFile, PluginOut, PluginVersionOut, Risk } from '../types'

const SECTION = 'text-[11px] font-semibold uppercase tracking-wider text-subtle'
const RISK_DOT: Record<Risk, string> = { low: 'bg-border-strong', medium: 'bg-accent', high: 'bg-warning', critical: 'bg-error' }

/** One permission: what it allows, in plain words, and the host or tool it names. */
function PermissionItem({ permission, change }: { permission: PermissionOut; change?: 'added' | 'removed' }) {
  const text = permissionText(permission)
  return (
    <li className={cn('flex items-start gap-2.5 py-(--item-y)', change === 'removed' && 'opacity-70')}>
      <span aria-hidden className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', RISK_DOT[permission.risk])} />
      <div className="min-w-0 flex-1">
        <div className={cn('flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium', change === 'removed' && 'line-through')}>
          {text.label}
          {change === 'added' && <Badge tone="warning"><Plus className="mr-0.5 h-3 w-3" />{t('New')}</Badge>}
          {change === 'removed' && <Badge><Minus className="mr-0.5 h-3 w-3" />{t('Taken out')}</Badge>}
        </div>
        <p className="text-[12.5px] text-muted">{text.explanation}</p>
        <code className="mt-0.5 block break-all font-mono text-[11px] text-subtle">{permission.name}</code>
      </div>
    </li>
  )
}

/**
 * Everything a version may do, from read-only to "asks every time". `added`/`removed` mark
 * the change from the approved version in an update's review.
 */
export function PermissionGroups({ permissions, added = [], removed = [] }: { permissions: PermissionOut[]; added?: string[]; removed?: PermissionOut[] }) {
  if (permissions.length === 0 && removed.length === 0) {
    return <p className="text-[13px] text-muted">{t('No permissions: it can show its own view and keep a little data of its own, nothing more.')}</p>
  }
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      {groupByRisk([...permissions, ...removed]).map(({ risk, items }) => (
        <section key={risk} aria-label={t(RISK_GROUPS[risk].title)}>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[13.5px] font-semibold">{t(RISK_GROUPS[risk].title)}</h4>
            <Badge tone={RISK_GROUPS[risk].tone}>{t(RISK_LABELS[risk])}</Badge>
          </div>
          <p className="text-[12.5px] text-muted">{t(RISK_GROUPS[risk].description)}</p>
          <ul className="mt-1">
            {items.map((p) => (
              <PermissionItem key={p.name} permission={p}
                change={removed.includes(p) ? 'removed' : added.includes(p.name) ? 'added' : undefined} />
            ))}
          </ul>
        </section>
      ))}
      {readsData(permissions) && (
        <p role="note" className="flex items-start gap-2 rounded-control bg-warning/12 px-3 py-2 text-[12.5px] text-warning">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t(READ_WARNING)}</span>
        </p>
      )}
    </div>
  )
}

/** What the version adds to Anemo, by kind (panels, commands, scripts, …). */
export function ContributionList({ contributions, action }: { contributions: ContributionOut[]; action?: (item: ContributionOut) => ReactNode }) {
  if (contributions.length === 0) return <p className="text-[13px] text-muted">{t('It adds nothing to Anemo besides its own settings.')}</p>
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      {groupContributions(contributions).map((group) => (
        <section key={group.kind} aria-label={group.title}>
          <h4 className={SECTION}>{group.title}</h4>
          <ul className="mt-1 divide-y divide-border">
            {group.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="flex items-center gap-3 py-(--item-y)">
                <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', RISK_DOT[item.risk])} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{item.label}</div>
                  {item.detail && <p className="break-words text-[12.5px] text-muted">{item.detail}</p>}
                </div>
                {item.risk !== 'low' && <Badge tone={RISK_GROUPS[item.risk].tone}>{t(RISK_LABELS[item.risk])}</Badge>}
                {action?.(item)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const SOURCE_KINDS = {
  zip: msg('Uploaded as a zip file'),
  git: msg('Installed from a Git repository'),
  assistant: msg('Made by the assistant in a chat'),
  bundled: msg('An example that comes with Anemo'),
}

/** Where the plugin came from, and the chats in which an assistant worked on it. */
export function SourceInfo({ plugin, chats = [] }: { plugin: PluginOut; chats?: { id: string; title: string }[] }) {
  const s = plugin.source
  const linked = chats.length > 0 ? chats : s.conversation_ids.map((id) => ({ id, title: t('A chat') }))
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="text-muted">{t('Source')}</dt>
      <dd>{t(SOURCE_KINDS[s.kind])}{s.kind === 'zip' && s.label ? `: ${s.label}` : ''}</dd>
      {s.url && (<><dt className="text-muted">{t('Address')}</dt><dd className="break-all font-mono text-[12px]">{s.url}</dd></>)}
      {s.ref && (<><dt className="text-muted">{t('Branch or tag')}</dt><dd className="font-mono text-[12px]">{s.ref}</dd></>)}
      {s.commit && (<><dt className="text-muted">{t('Commit')}</dt><dd className="break-all font-mono text-[12px]">{s.commit}</dd></>)}
      {linked.length > 0 && (
        <>
          <dt className="text-muted">{t('Chats')}</dt>
          <dd className="flex flex-col gap-0.5">
            {linked.map((c) => <Link key={c.id} to={chatLink(c.id)} className="text-accent hover:underline">{c.title}</Link>)}
          </dd>
        </>
      )}
    </dl>
  )
}

const FILE_STATUS: Record<PluginDiffFile['status'], { label: string; tone: 'success' | 'error' | 'accent' | 'neutral' }> = {
  added: { label: msg('Added'), tone: 'success' },
  removed: { label: msg('Removed'), tone: 'error' },
  changed: { label: msg('Changed'), tone: 'accent' },
  same: { label: msg('Unchanged'), tone: 'neutral' },
}

/** One file of an update: its state, and its diff when opened. */
function FileDiff({ file }: { file: PluginDiffFile }) {
  const [open, setOpen] = useState(file.status !== 'same' && (file.after ?? file.before ?? '').length < 6000)
  const text = file.before !== undefined || file.after !== undefined
  return (
    <li className="py-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left hover:bg-surface-hover">
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
        <Badge tone={FILE_STATUS[file.status].tone}>{t(FILE_STATUS[file.status].label)}</Badge>
      </button>
      {open && (text
        ? <DiffView className="mt-1 max-h-[40vh]" label={file.path}
            before={file.status === 'added' ? null : file.status === 'removed' ? (file.before ?? '') : (file.before ?? null)}
            after={file.status === 'removed' ? '' : (file.after ?? '')} />
        : <p className="mt-1 px-1 font-mono text-[11.5px] text-muted">{t('A picture or font (not shown as text).')} sha256 {file.sha256}</p>)}
    </li>
  )
}

/** The diff of an update against the approved version: permissions, manifest and files. */
function UpdateDiff({ pluginId, version }: { pluginId: string; version: PluginVersionOut }) {
  const diff = usePluginDiff(pluginId, version.version)
  if (diff.isError) return <p className="text-[12.5px] text-error">{errorMessage(diff.error)}</p>
  if (!diff.data) return <p className="text-[13px] text-muted">{t('Loading…')}</p>
  const d = diff.data
  const changed = d.files.filter((f) => f.status !== 'same')
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      <section aria-label={t('Permissions')}>
        <h4 className={SECTION}>{t('Permissions')}</h4>
        {d.permissions.added.length === 0 && d.permissions.removed.length === 0 && (
          <p className="mt-1 text-[13px] text-muted">{t('The same permissions as the approved version.')}</p>
        )}
        <div className="mt-1.5">
          <PermissionGroups permissions={[...d.permissions.kept, ...d.permissions.added]} added={d.permissions.added.map((p) => p.name)} removed={d.permissions.removed} />
        </div>
      </section>
      <section aria-label={t('Manifest')}>
        <h4 className={SECTION}>{t('Manifest')}</h4>
        <DiffView className="mt-1.5 max-h-[40vh]" label={t('Manifest')}
          before={d.manifest.before ? JSON.stringify(d.manifest.before, null, 2) : null} after={JSON.stringify(d.manifest.after, null, 2)} />
      </section>
      <section aria-label={t('Files')}>
        <h4 className={SECTION}>{t('Files')} · {plural(changed.length, '{n} changed', '{n} changed')}</h4>
        <ul className="mt-1">{d.files.map((f) => <FileDiff key={f.path} file={f} />)}</ul>
      </section>
    </div>
  )
}

/**
 * A version waiting for the user: what it may do and add (or, for an update, what changes),
 * and the decision. Approving needs the password and names the version's hash, so a newer
 * upload in the meantime is refused rather than approved unseen.
 *
 * `onClose`: the install flow's "Not now" (the plugin stays "Needs review"); without it the
 * version can be rejected here.
 */
export function VersionReview({ plugin, version, onDone, onClose }: {
  plugin: PluginDetailOut
  version: PluginVersionOut
  onDone?: () => void
  onClose?: () => void
}) {
  const approve = useApproveVersion()
  const reject = useRejectVersion()
  const isUpdate = plugin.approved_version !== null && plugin.approved_version !== version.version
  const error = approve.error ?? reject.error
  const decide = (enable: boolean) =>
    approve.mutate({ id: plugin.id, version: version.version, hash: version.hash, enable }, { onSuccess: () => onDone?.() })
  const files = version.files.reduce((sum, f) => sum + f.size, 0)
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      <p className="text-[13px] text-muted">
        {plugin.made_by_assistant
          ? t('An assistant made this version. Nothing of it runs until you approve it, exactly as shown here.')
          : t('Nothing of it runs until you approve it, exactly as shown here.')}
        {' '}
        {plural(version.files.length, '{n} file, {size}', '{n} files, {size}', { size: formatSize(files) })}
      </p>
      {isUpdate ? (
        <UpdateDiff pluginId={plugin.id} version={version} />
      ) : (
        <>
          <section aria-label={t('Permissions')}>
            <h4 className={SECTION}>{t('Permissions')}</h4>
            <div className="mt-1.5"><PermissionGroups permissions={version.permissions} /></div>
          </section>
          <section aria-label={t('What it adds')}>
            <h4 className={SECTION}>{t('What it adds')}</h4>
            <div className="mt-1.5"><ContributionList contributions={version.contributions} /></div>
          </section>
        </>
      )}
      <section aria-label={t('Source')}>
        <h4 className={SECTION}>{t('Source')}</h4>
        <div className="mt-1.5"><SourceInfo plugin={plugin} chats={plugin.chats} /></div>
      </section>
      {error && <p role="alert" className="text-[12.5px] text-error">{errorMessage(error)}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-(--card-y)">
        {onClose ? (
          <Button variant="ghost" onClick={onClose}>{t('Not now')}</Button>
        ) : (
          <Button variant="ghost" loading={reject.isPending}
            onClick={() => reject.mutate({ id: plugin.id, version: version.version }, { onSuccess: () => onDone?.() })}>
            {t('Reject')}
          </Button>
        )}
        <Button loading={approve.isPending && approve.variables?.enable === false} disabled={approve.isPending} onClick={() => decide(false)}>
          {t('Approve, keep off')}
        </Button>
        <Button variant="primary" loading={approve.isPending && approve.variables?.enable === true} disabled={approve.isPending} onClick={() => decide(true)}>
          {t('Approve and enable')}
        </Button>
      </div>
    </div>
  )
}
