/**
 * Settings > Advanced: the version, updates, the first-run setup, whether each part of
 * the system is working, and the log of security-relevant events (logins, changed
 * settings, approvals). The place to look when something is off.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { RefreshCw, Rocket, Wrench } from 'lucide-react'
import { api, errorMessage, type Schemas, unwrap } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { shortCommit } from '@/features/updates/api'
import { UpdatesCard, WhatsNewCard } from '@/features/updates/UpdatesCards'
import { formatWhen } from '@/lib/format'
import { useSettings } from '../api'
import { CheckRow } from '../CheckRow'
import { useSystemStatus } from '../systemStatus'

type AuditEntry = Schemas['AuditOut']


function useAuditLog() {
  return useQuery({
    queryKey: ['audit'],
    queryFn: async () => unwrap(await api.GET('/api/audit', { params: { query: { limit: 50 } } })),
    staleTime: 0,
  })
}

/** The first-run setup can be opened again from here, or picked up where it was left. */
function SetupCard() {
  const settings = useSettings()
  const setup = settings.data?.setup
  if (!setup) return null
  const done = setup.status === 'done'
  return (
    <Card>
      <CardHeader title="First-run setup"
        description={done
          ? 'Finished. Go through it again to check the providers, models and optional parts.'
          : 'A few steps: a model provider, helper models, your time zone, optional parts and notifications.'}
        actions={
          <Link to="/setup" className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-[13px] font-medium hover:bg-surface-hover pointer-coarse:h-10">
            <Rocket className="h-3.5 w-3.5" aria-hidden />
            {done ? 'Open setup' : setup.step ? 'Continue setup' : 'Start setup'}
          </Link>
        } />
      <div className="pb-2" />
    </Card>
  )
}

/** "settings.update" → "Settings update"; the details say which and what. */
function describe(entry: AuditEntry): string {
  const action = entry.action.replaceAll('.', ' ').replaceAll('_', ' ')
  const name = (entry.details as { name?: string } | null)?.name ?? (entry.target_type === 'settings' ? entry.target_id : null)
  return action.charAt(0).toUpperCase() + action.slice(1) + (name ? `: ${name}` : '')
}

export function AdvancedPage() {
  const status = useSystemStatus()
  const audit = useAuditLog()
  const problems = (status.data?.checks ?? []).filter((c) => !c.ok && !c.optional).length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Wrench className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Advanced</h2>
          <p className="text-[13px] text-muted">
            Anemo {status.data ? `version ${status.data.version}` : ''}
            {status.data?.commit && <> · commit <code className="font-mono" title={status.data.commit}>{shortCommit(status.data.commit)}</code></>}
            {status.data && <> · {status.data.install === 'image' ? 'prebuilt image' : 'built from source'}</>}
            {status.data?.database_version && <> · database version {status.data.database_version}</>}
          </p>
        </div>
      </div>

      <WhatsNewCard />
      <UpdatesCard />
      <SetupCard />

      <Card>
        <CardHeader title="System status"
          description={status.data ? (problems ? `${problems} thing${problems === 1 ? '' : 's'} need attention.` : 'Everything that should run is running.') : undefined}
          actions={
            <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={status.isFetching}
              onClick={() => void status.refetch()}>
              Check again
            </Button>
          } />
        <CardBody className="py-2">
          {status.isError && <p className="py-2 text-[13px] text-error">{errorMessage(status.error)}</p>}
          <ul>{status.data?.checks.map((check) => <CheckRow key={check.name} check={check} />)}</ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Security log" description="The last 50 logins, settings changes, approvals and similar events." />
        <CardBody className="py-2">
          {audit.isError && <p className="py-2 text-[13px] text-error">{errorMessage(audit.error)}</p>}
          {audit.data?.length === 0 && <p className="py-2 text-[13px] text-muted">Nothing recorded yet.</p>}
          <ul className="text-[13px]">
            {audit.data?.map((entry) => (
              <li key={entry.id} className="flex items-baseline gap-3 border-t border-border py-2 first:border-t-0">
                <span className="w-28 shrink-0 text-[12px] text-muted">{formatWhen(entry.ts)}</span>
                <span className="min-w-0 flex-1 break-words">{describe(entry)}</span>
                <span className="shrink-0 text-[12px] text-subtle">{entry.actor === 'user' ? (entry.ip ?? '') : entry.actor}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}
