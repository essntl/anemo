/**
 * The tools of one MCP server. For each tool you can turn it off, decide whether
 * it asks before it runs, and correct how risky it is. Tools that changed since
 * you set the server up ask every time until you have looked at them.
 */
import { AlertTriangle } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { type McpTool, type McpToolPatch, type Risk, RISK_LABELS, useMcpTools, useUpdateMcpTool } from '../api'

const RISK_TONES: Record<Risk, 'success' | 'neutral' | 'error'> = { safe: 'success', moderate: 'neutral', dangerous: 'error' }

const PERMISSION_OPTIONS = [
  { value: '', label: 'Follow Agent Permissions' },
  { value: 'ask', label: 'Always ask me' },
  { value: 'allow', label: 'Run without asking' },
  { value: 'deny', label: 'Never' },
]

function ToolRow({ tool }: { tool: McpTool }) {
  const update = useUpdateMcpTool()
  const change = (body: McpToolPatch) => update.mutate({ id: tool.id, body })
  const riskOptions = [
    { value: '', label: `As the server says (${RISK_LABELS[tool.risk_from_server].toLowerCase()})` },
    ...(Object.keys(RISK_LABELS) as Risk[]).map((r) => ({ value: r, label: RISK_LABELS[r] })),
  ]

  return (
    <li className={cn('border-t border-border py-3 first:border-t-0', !tool.enabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Switch label={`Offer ${tool.name} to agents`} checked={tool.enabled} onChange={(enabled) => change({ enabled })} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-[13px] font-medium">{tool.name}</span>
            <Badge tone={RISK_TONES[tool.risk]}>{RISK_LABELS[tool.risk]}</Badge>
          </div>
          {tool.description && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[12.5px] text-muted">{tool.description}</p>}
        </div>
      </div>

      {tool.needs_review && (
        <div className="ml-12 mt-2 flex flex-wrap items-center gap-2 rounded-control border border-warning/40 bg-warning/8 px-3 py-2 text-[12.5px]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            New or changed since you set this server up. It asks every time until you have checked the description above.
          </span>
          <Button size="sm" variant="secondary" loading={update.isPending} onClick={() => change({ reviewed: true })}>
            Looks fine
          </Button>
        </div>
      )}

      {tool.enabled && (
        <div className="ml-12 mt-2 grid gap-2 sm:grid-cols-2">
          <Select aria-label={`Permission for ${tool.name}`} className="h-9 text-[13px]" value={tool.permission ?? ''}
            options={PERMISSION_OPTIONS}
            onValueChange={(v) => change({ permission: (v || null) as McpToolPatch['permission'] })} />
          <Select aria-label={`Risk of ${tool.name}`} className="h-9 text-[13px]" value={tool.risk_override ?? ''}
            options={riskOptions}
            onValueChange={(v) => change({ risk_override: (v || null) as McpToolPatch['risk_override'] })} />
        </div>
      )}
      {update.isError && <p className="ml-12 mt-1 text-[12.5px] text-error">{errorMessage(update.error)}</p>}
    </li>
  )
}

export function ToolList({ serverId }: { serverId: string }) {
  const tools = useMcpTools(serverId)
  if (tools.isError) return <p className="text-[13px] text-error">{errorMessage(tools.error)}</p>
  if (!tools.data) return <p className="text-[13px] text-muted">Loading…</p>
  if (tools.data.length === 0) return <p className="text-[13px] text-muted">No tools found yet.</p>
  // Tools waiting for a look come first.
  const sorted = [...tools.data].sort((a, b) => Number(b.needs_review) - Number(a.needs_review))
  return <ul>{sorted.map((tool) => <ToolRow key={tool.id} tool={tool} />)}</ul>
}
