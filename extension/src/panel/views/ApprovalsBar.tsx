/**
 * Something is waiting for your approval in a chat you aren't looking at: says so, with a
 * way there. (The toolbar badge counts them; this is where they are.)
 */
import { useQuery } from '@tanstack/react-query'
import { ShieldQuestion } from 'lucide-react'
import { unwrap } from '@/shared/api'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'

export function ApprovalsBar({ showing, onOpen }: { showing: string | null; onOpen: (conversationId: string) => void }) {
  const { api } = useSession()
  const count = useStored('session', 'badge').value?.approvals ?? 0
  const pending = useQuery({
    queryKey: ['approvals', count],
    enabled: count > 0,
    queryFn: async () => unwrap(await api.GET('/api/approvals')),
  })
  const elsewhere = count > 0 ? (pending.data ?? []).filter((a) => a.conversation_id && a.conversation_id !== showing) : []
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  return (
    <button
      type="button"
      onClick={() => onOpen(first.conversation_id!)}
      className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-3 py-1 text-left text-[12px] hover:bg-warning/20"
    >
      <ShieldQuestion className="h-3.5 w-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{elsewhere.length === 1 ? 'Waiting for your approval' : `${elsewhere.length} approvals waiting`}</span>
        {elsewhere.length === 1 && <span className="text-muted"> · {first.summary}</span>}
      </span>
      <span className="shrink-0 font-medium text-accent">Open</span>
    </button>
  )
}
