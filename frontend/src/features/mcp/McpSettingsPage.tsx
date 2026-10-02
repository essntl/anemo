/**
 * Settings > MCP: the MCP servers whose tools agents may use. Security-sensitive:
 * changes ask for the password. Whether MCP tools ask before they run is the
 * "MCP tools" level in Agent Permissions, with exceptions per tool here.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { type McpServer, useDeleteMcpServer, useMcpServers, useRefreshMcpServer, useSetMcpServerEnabled } from './api'
import { ServerDialog } from './components/ServerDialog'
import { ToolList } from './components/ToolList'
import { Lingering } from '@/components/ui/Lingering'

function StatusBadge({ server }: { server: McpServer }) {
  if (!server.enabled) return <Badge>Off</Badge>
  if (server.status === 'ok') return <Badge tone="success">Connected</Badge>
  if (server.status === 'error') return <Badge tone="error">Not working</Badge>
  return <Badge tone="accent">Checking…</Badge>
}

function ServerCard({ server, onEdit }: { server: McpServer; onEdit: () => void }) {
  const setEnabled = useSetMcpServerEnabled()
  const refresh = useRefreshMcpServer()
  const remove = useDeleteMcpServer()
  const [open, setOpen] = useState(false)
  const error = setEnabled.error ?? refresh.error ?? remove.error
  const where = server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Remove “${server.name}”?`,
      message: 'Agents can no longer use its tools. Saved headers or variables are deleted.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) remove.mutate(server.id)
  }

  return (
    <Card>
      <CardBody className="py-4">
        <div className="flex items-start gap-3">
          <div className="pt-1">
            <Switch label={`Use ${server.name}`} checked={server.enabled}
              onChange={(enabled) => setEnabled.mutate({ id: server.id, enabled })} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 break-words text-[15px] font-semibold">{server.name}</h3>
              <StatusBadge server={server} />
              <Badge>{server.transport === 'stdio' ? 'Local' : 'Remote'}</Badge>
              {server.review_count > 0 && <Badge tone="warning">{server.review_count} to review</Badge>}
            </div>
            <p className="mt-0.5 break-all font-mono text-[12px] text-muted">{where}</p>
            {server.status === 'error' && server.last_error && (
              <p className="mt-1.5 break-words text-[12.5px] text-error">{server.last_error}</p>
            )}
          </div>
          <ActionMenu actions={[
            { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
            { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
          ]} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </Button>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />}
            loading={refresh.isPending || server.status === 'checking'} onClick={() => refresh.mutate(server.id)}>
            Check again
          </Button>
        </div>
        {error && <p className="mt-2 pl-12 text-[12.5px] text-error">{errorMessage(error)}</p>}
        {open && <div className="mt-2 border-t border-border pt-1"><ToolList serverId={server.id} /></div>}
      </CardBody>
    </Card>
  )
}

export function McpSettingsPage() {
  const servers = useMcpServers()
  // null: closed. { server: null }: adding one.
  const [editing, setEditing] = useState<{ server: McpServer | null } | null>(null)
  const items = servers.data ?? []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Plug className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">MCP</h2>
          <p className="text-[13px] text-muted">
            Connect MCP servers to give agents more tools. Whether those tools ask first is the “MCP tools” level in{' '}
            <Link to="/settings/permissions" className="text-accent underline">Agent Permissions</Link> (they always ask by
            default); you can make exceptions per tool here.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ server: null })}>
          Add
        </Button>
      </div>

      {servers.isError && <p className="text-[13px] text-error">{errorMessage(servers.error)}</p>}
      {servers.isSuccess && items.length === 0 && (
        <Card>
          <EmptyState icon={<Plug className="h-5 w-5" />} title="No MCP servers yet"
            description="Add a remote server by its URL, or a local one by the command that starts it. Its tools then show up for agents in Agent mode." />
        </Card>
      )}
      {items.map((server) => <ServerCard key={server.id} server={server} onEdit={() => setEditing({ server })} />)}

      <Lingering value={editing}>{(shown) => <ServerDialog server={shown.server} onClose={() => setEditing(null)} />}</Lingering>
    </div>
  )
}
