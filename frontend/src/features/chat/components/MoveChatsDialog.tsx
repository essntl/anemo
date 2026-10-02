import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Lingering } from '@/components/ui/Lingering'
import { Select } from '@/components/ui/Select'
import { useProjects } from '@/features/tasks/api'
import { useBulkChats } from '../api'
import { useMoveChats } from '../chatActions'

function MoveDialog({ ids, current }: { ids: string[]; current: string | null }) {
  const close = useMoveChats((s) => s.close)
  const projects = useProjects()
  const bulk = useBulkChats()
  const [projectId, setProjectId] = useState(current ?? '')
  const options = [
    { value: '', label: 'No project' },
    ...(projects.data ?? []).filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name })),
  ]
  const move = () =>
    bulk.mutate({ ids, action: 'set_project', projectId: projectId || null }, { onSuccess: close })
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={ids.length === 1 ? 'Move chat to a project' : `Move ${ids.length} chats to a project`}
      description="A chat belongs to one project at most. Its messages stay as they are."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={bulk.isPending} onClick={move}>Move</Button>
        </>
      }
    >
      <Select aria-label="Project" value={projectId} onValueChange={setProjectId} options={options} />
      {bulk.isError && <p className="mt-2 text-[13px] text-error">{errorMessage(bulk.error)}</p>}
    </Dialog>
  )
}

/** Mounted once (AppLayout): shows the "Move to project" dialog when something asks for it. */
export function MoveChatsDialog() {
  const { ids, current } = useMoveChats()
  return <Lingering value={ids}>{(shown) => <MoveDialog ids={shown} current={current} />}</Lingering>
}
