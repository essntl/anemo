/**
 * Settings > Advanced: the update notice (how many changes main has that this build
 * doesn't, and the command that updates this kind of install) and, once after an
 * update, what changed. Anemo never updates itself.
 */
import { useState } from 'react'
import { Check, Copy, RefreshCw, Sparkles } from 'lucide-react'
import { errorMessage, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { formatWhen } from '@/lib/format'
import { plural, rich, t } from '@/lib/i18n'
import { shortCommit, type Updates, useCheckUpdates, useDismissUpdate, useDismissWhatsNew, useUpdates } from './api'

type Change = Schemas['Change']

function Changes({ changes, total, label }: { changes: Change[]; total: number; label: string }) {
  return (
    <div>
      <ul aria-label={label} className="flex flex-col">
        {changes.map((c) => (
          <li key={c.sha} className="flex items-baseline gap-3 border-t border-border py-1.5 text-[13px] first:border-t-0">
            <span className="min-w-0 flex-1 break-words">{c.title}</span>
            {c.date && <span className="shrink-0 text-[12px] text-subtle">{formatWhen(c.date)}</span>}
          </li>
        ))}
      </ul>
      {total > changes.length && <p className="pt-1.5 text-[12px] text-muted">{t('and {n} older', { n: total - changes.length })}</p>}
    </div>
  )
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-center gap-2 rounded-control border border-border bg-surface-2 py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px]">{command}</code>
      <Button size="sm" variant="ghost" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        aria-label={t('Copy the update command')} onClick={() => void copy()}>
        {copied ? t('Copied') : t('Copy')}
      </Button>
    </div>
  )
}

function summary(u: Updates): string {
  if (u.env_disabled) return t('Switched off with UPDATE_CHECK=false in .env.')
  if (!u.commit) return t('This build doesn’t say which commit it was made from, so it can’t be compared with main.')
  if (!u.enabled) return t('Switched off. Anemo doesn’t ask GitHub about updates.')
  if (!u.checked_at) return t('Not checked yet. Anemo looks about once a day.')
  if (u.status === 'available') return plural(u.behind_by, '{n} new change on main since this version.', '{n} new changes on main since this version.')
  if (u.status === 'up_to_date') return t('Up to date with main.')
  return t('Couldn’t check: {reason}.', { reason: u.error ?? t('unknown reason') })
}

export function UpdatesCard() {
  const updates = useUpdates({ staleTime: 0 })
  const settings = useSettings()
  const save = useSaveSection('updates')
  const check = useCheckUpdates()
  const dismiss = useDismissUpdate()
  const u = updates.data
  const on = settings.data?.updates.check ?? true

  const toggle = (next: boolean) =>
    save.mutate({ check: next }, { onSuccess: () => void updates.refetch() })

  return (
    <Card>
      <CardHeader title={t('Updates')}
        description={u ? summary(u) : undefined}
        actions={u?.commit && u.enabled ? (
          <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={check.isPending}
            onClick={() => check.mutate()}>
            {t('Check now')}
          </Button>
        ) : undefined} />
      <CardBody className="flex flex-col gap-4">
        {updates.isError && <p className="text-[13px] text-error">{errorMessage(updates.error)}</p>}
        {check.isError && <p className="text-[13px] text-error">{errorMessage(check.error)}</p>}
        {u && (
          <>
            <div className="flex items-center justify-between gap-4 text-[13px]">
              <div>
                <div className="font-medium">{t('Check for updates')}</div>
                <div className="text-[12px] text-muted">
                  {t('About once a day, ask GitHub ({repo}) how many changes its main branch has that this version doesn’t. Nothing about you is sent. Anemo never updates itself.', { repo: u.repo })}
                </div>
              </div>
              <Switch label={t('Check for updates')} checked={on && !u.env_disabled} disabled={u.env_disabled || save.isPending} onChange={toggle} />
            </div>
            {u.status === 'available' && u.changes.length > 0 && (
              <Changes changes={u.changes} total={u.behind_by} label={t('New changes on main')} />
            )}
            {u.status === 'available' && (
              <div className="flex flex-col gap-2">
                <p className="text-[13px]">{t('To update, run this in Anemo’s folder on the server:')}</p>
                <Command command={u.command} />
                {u.notice && (
                  <div>
                    <Button size="sm" variant="ghost" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>
                      {t('Not now')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {!u.commit && (
              <p className="text-[12.5px] text-muted">
                {rich('The prebuilt images record it. A build from a checkout does when started with <code>make up</code>, or with <code>APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build</code>.', { code: (c) => <code className="font-mono">{c}</code> })}
              </p>
            )}
            {u.checked_at && <p className="text-[12px] text-subtle">{t('Last checked {when}', { when: formatWhen(u.checked_at) })}</p>}
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** Once after an update: the changes since the version that ran before. */
export function WhatsNewCard() {
  const updates = useUpdates()
  const dismiss = useDismissWhatsNew()
  const news = updates.data?.whats_new
  if (!news) return null
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" aria-hidden />{t('What’s new')}</span>}
        description={plural(news.total, 'Anemo was updated from {from} to {to}: {n} change.', 'Anemo was updated from {from} to {to}: {n} changes.', { from: shortCommit(news.from_commit), to: shortCommit(news.to_commit) })}
        actions={<Button size="sm" variant="secondary" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>{t('Got it')}</Button>} />
      <CardBody className="py-3">
        <Changes changes={news.changes ?? []} total={news.total} label={t('Changes in this update')} />
      </CardBody>
    </Card>
  )
}
