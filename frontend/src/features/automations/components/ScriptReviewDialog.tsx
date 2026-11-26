/**
 * A script's code, for review. With a change waiting: the diff between the approved
 * version and the new one (the code line by line, and what it may use), and Approve /
 * Approve and switch on / Discard. Approving needs the password, and approves exactly
 * the version shown (by its hash). Also where the script's secrets are set.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DiffView } from '@/components/ui/DiffView'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { formatWhen } from '@/lib/format'
import { msg, t } from '@/lib/i18n'
import {
  type Automation,
  type ScriptVersion,
  useApproveScript,
  useDiscardScriptChange,
  useScript,
  useScriptSecret,
} from '../api'
import { listDiff } from '@/lib/lineDiff'

const LISTS: { key: 'tools' | 'hosts' | 'secrets' | 'think_tools'; label: string }[] = [
  { key: 'tools', label: msg('Tools it may call') },
  { key: 'hosts', label: msg('Hosts it may reach') },
  { key: 'secrets', label: msg('Secrets it uses') },
  { key: 'think_tools', label: msg('Tools of its think steps') },
]

function Author({ version }: { version: ScriptVersion }) {
  const by = version.created_by
  return (
    <span className="text-[12px] text-muted">
      {t('Version {n}', { n: version.number })} · {formatWhen(version.created_at)}
      {by && <> · {by.url ? <Link to={by.url} className="text-accent hover:underline">{by.label}</Link> : by.label}</>}
    </span>
  )
}

/** What the version may use, with what the change adds or takes out. */
function Lists({ before, after }: { before: ScriptVersion | null; after: ScriptVersion }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-[max-content_1fr]">
      {LISTS.map(({ key, label }) => {
        const diff = listDiff(before?.[key] ?? [], after[key])
        if (diff.added.length + diff.removed.length + diff.kept.length === 0) return null
        return (
          <div key={key} className="contents">
            <dt className="text-muted">{t(label)}</dt>
            <dd className="flex flex-wrap gap-1 font-mono text-[11.5px]">
              {diff.kept.map((x) => <span key={x} className="rounded bg-surface-2 px-1.5">{x}</span>)}
              {before && diff.added.map((x) => <span key={x} className="rounded bg-success/12 px-1.5 text-success">+ {x}</span>)}
              {!before && diff.added.map((x) => <span key={x} className="rounded bg-surface-2 px-1.5">{x}</span>)}
              {diff.removed.map((x) => <span key={x} className="rounded bg-error/12 px-1.5 text-error line-through">{x}</span>)}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function Secrets({ automation, names }: { automation: Automation; names: { name: string; value_hint: string | null }[] }) {
  const save = useScriptSecret()
  const [values, setValues] = useState<Record<string, string>>({})
  if (names.length === 0) return null
  return (
    <section className="mt-4 border-t border-border pt-3">
      <h3 className="text-[13px] font-semibold">{t('Secrets')}</h3>
      <p className="mb-2 text-[12px] text-muted">{t('The script never sees them: the server puts them into requests to its hosts. They are never shown again.')}</p>
      <div className="flex flex-col gap-2">
        {names.map((s) => (
          <div key={s.name} className="flex flex-wrap items-center gap-2">
            <span className="w-40 shrink-0 font-mono text-[12px]">{s.name}</span>
            <Input type="password" className="h-8 min-w-0 flex-1" autoComplete="off" aria-label={t('Value of {name}', { name: s.name })}
              placeholder={s.value_hint ?? t('Not set')} value={values[s.name] ?? ''}
              onChange={(e) => setValues({ ...values, [s.name]: e.target.value })} />
            <Button size="sm" disabled={!values[s.name]} loading={save.isPending && save.variables?.name === s.name && save.variables.value !== null}
              onClick={() => save.mutate({ id: automation.id, name: s.name, value: values[s.name] }, { onSuccess: () => setValues({ ...values, [s.name]: '' }) })}>
              {t('Set')}
            </Button>
            {s.value_hint && (
              <Button size="sm" variant="ghost" onClick={() => save.mutate({ id: automation.id, name: s.name, value: null })}>{t('Clear')}</Button>
            )}
          </div>
        ))}
      </div>
      {save.isError && <p className="mt-2 text-[12.5px] text-error">{errorMessage(save.error)}</p>}
    </section>
  )
}

export function ScriptReviewDialog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const script = useScript(automation.id, [automation.script_pending, automation.script_approved].join('|'))
  const approve = useApproveScript()
  const discard = useDiscardScriptChange()
  const data = script.data
  const approved = data?.approved ?? null
  const pending = data?.pending ?? null
  const shown = pending ?? approved
  const error = approve.error ?? discard.error ?? script.error

  const doApprove = (enable: boolean) =>
    pending && approve.mutate({ id: automation.id, hash: pending.hash, enable }, { onSuccess: onClose })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(96vw,860px)]"
      title={pending ? t('Review the change to “{name}”', { name: automation.name }) : t('Code of “{name}”', { name: automation.name })}
      description={pending
        ? t('An assistant wrote this. It runs only after you approve it, exactly as shown here.')
        : t('This is the approved code: the only code this script runs.')}
      footer={
        <>
          {error && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(error)}</span>}
          {pending ? (
            <>
              {approved && (
                <Button variant="ghost" loading={discard.isPending} onClick={() => discard.mutate(automation.id, { onSuccess: onClose })}>
                  {t('Discard change')}
                </Button>
              )}
              <Button loading={approve.isPending && !approve.variables?.enable} onClick={() => doApprove(false)}>{t('Approve')}</Button>
              <Button variant="primary" loading={approve.isPending && approve.variables?.enable} onClick={() => doApprove(true)}>
                {t('Approve and switch on')}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>{t('Close')}</Button>
          )}
        </>
      }>
      {!data && !script.isError && <p className="text-[13px] text-muted">{t('Loading…')}</p>}
      {shown && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {pending && approved && <Badge tone="warning">{t('Changed since version {n}', { n: approved.number })}</Badge>}
            {pending && !approved && <Badge tone="warning">{t('New: never approved')}</Badge>}
            <Author version={shown} />
          </div>
          <Lists before={pending ? approved : null} after={shown} />
          <DiffView before={pending && approved ? approved.code : null} after={shown.code} />
          {data && <Secrets automation={automation} names={data.secrets} />}
        </div>
      )}
      {data && !shown && <p className="text-[13px] text-muted">{t('This script has no code.')}</p>}
    </Dialog>
  )
}
