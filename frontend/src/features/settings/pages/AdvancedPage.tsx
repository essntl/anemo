/**
 * Settings > Advanced: the version, whether each part of the system is working,
 * and the log of security-relevant events (logins, changed settings, approvals).
 * Nothing can be changed here; it is the place to look when something is off.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CircleSlash, RefreshCw, Wrench } from 'lucide-react'
import { api, errorMessage, type Schemas, unwrap } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { formatWhen } from '@/lib/format'

type Check = Schemas['Check']
type AuditEntry = Schemas['AuditOut']

function useSystemStatus() {
  return useQuery({
    queryKey: ['system', 'status'],
    queryFn: async () => unwrap(await api.GET('/api/system/status')),
    staleTime: 0, // always fresh when the page is opened
  })
}

function useAuditLog() {
  return useQuery({
    queryKey: ['audit'],
    queryFn: async () => unwrap(await api.GET('/api/audit', { params: { query: { limit: 50 } } })),
    staleTime: 0,
  })
}

function CheckRow({ check }: { check: Check }) {
  // An optional part that is off is not a problem, just a fact.
  const Icon = check.ok ? CheckCircle2 : check.optional ? CircleSlash : AlertTriangle
  const tone = check.ok ? 'text-success' : check.optional ? 'text-subtle' : 'text-error'
  return (
    <li className="flex items-start gap-3 border-t border-border py-2.5 first:border-t-0">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{check.name}</div>
        <div className={`break-words text-[12.5px] ${check.ok || check.optional ? 'text-muted' : 'text-error'}`}>{check.detail}</div>
      </div>
    </li>
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
            {status.data?.database_version && <> · database version {status.data.database_version}</>}
          </p>
        </div>
      </div>

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
