import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { withReauth } from '@/features/auth/reauthStore'

export type McpServer = Schemas['McpServerOut']
export type McpTool = Schemas['McpToolOut']
export type McpToolPatch = Schemas['McpToolPatch']
export type Transport = McpServer['transport']
export type Risk = McpTool['risk']

export const mcpKey = ['mcp'] as const

export const RISK_LABELS: Record<Risk, string> = {
  safe: 'Only reads',
  moderate: 'Makes changes',
  dangerous: 'Risky',
}

export function useMcpServers() {
  return useQuery({
    queryKey: [...mcpKey, 'servers'],
    queryFn: async () => unwrap(await api.GET('/api/mcp/servers')),
    // While a server is being checked the worker is busy with it: look again shortly.
    // (A change also arrives as an event; this covers a missed one.)
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === 'checking') ? 3000 : false),
  })
}

export function useMcpTools(serverId: string) {
  return useQuery({
    queryKey: [...mcpKey, 'tools', serverId],
    queryFn: async () =>
      unwrap(await api.GET('/api/mcp/servers/{server_id}/tools', { params: { path: { server_id: serverId } } })),
  })
}

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: mcpKey })
    void qc.invalidateQueries({ queryKey: ['permissions', 'summary'] })
  }
}

/** What the server dialog collects. Headers and env are only sent when changed. */
export interface ServerForm {
  name: string
  transport: Transport
  url: string
  command: string
  args: string[]
  /** null: keep what is saved. */
  headers: Record<string, string> | null
  env: Record<string, string> | null
}

/** Add or change a server. Asks for the password first (it gives agents new abilities). */
export function useSaveMcpServer() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (v: { id?: string; form: ServerForm }) =>
      withReauth(async () => {
        const f = v.form
        const local = f.transport === 'stdio'
        if (!v.id) {
          return unwrap(
            await api.POST('/api/mcp/servers', {
              body: {
                name: f.name,
                transport: f.transport,
                url: local ? null : f.url,
                command: local ? f.command : null,
                args: local ? f.args : [],
                headers: local ? null : f.headers,
                env: local ? f.env : null,
                enabled: true,
              },
            }),
          )
        }
        return unwrap(
          await api.PATCH('/api/mcp/servers/{server_id}', {
            params: { path: { server_id: v.id } },
            body: {
              name: f.name,
              ...(local ? { command: f.command, args: f.args } : { url: f.url }),
              ...(!local && f.headers !== null ? { headers: f.headers } : {}),
              ...(local && f.env !== null ? { env: f.env } : {}),
            },
          }),
        )
      }),
    onSuccess: refresh,
  })
}

export function useSetMcpServerEnabled() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      withReauth(async () =>
        unwrap(
          await api.PATCH('/api/mcp/servers/{server_id}', {
            params: { path: { server_id: v.id } },
            body: { enabled: v.enabled },
          }),
        ),
      ),
    onSettled: refresh,
  })
}

export function useDeleteMcpServer() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (id: string) =>
      withReauth(async () =>
        unwrap(await api.DELETE('/api/mcp/servers/{server_id}', { params: { path: { server_id: id } } })),
      ),
    onSuccess: refresh,
  })
}

/** Ask the server for its tools again (done in the background; the status shows the result). */
export function useRefreshMcpServer() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/mcp/servers/{server_id}/refresh', { params: { path: { server_id: id } } })),
    onSettled: refresh,
  })
}

export function useUpdateMcpTool() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (v: { id: string; body: McpToolPatch }) =>
      withReauth(async () =>
        unwrap(await api.PATCH('/api/mcp/tools/{tool_id}', { params: { path: { tool_id: v.id } }, body: v.body })),
      ),
    onSettled: refresh,
  })
}
