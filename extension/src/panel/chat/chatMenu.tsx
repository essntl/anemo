/**
 * What you can do with a chat (as in Anemo): keep a temporary one, rename, add to
 * favorites, archive, delete. Used by the chat list and the open chat's header.
 */
import { useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ExternalLink, Pencil, Save, Star, StarOff, Trash2 } from 'lucide-react'
import { ConfirmDialog, PromptDialog } from '../ui/Dialog'
import type { MenuAction } from '../ui/Menu'
import { toast } from '../ui/toast'
import { useSession } from '../state/useSession'
import { useDeleteConversation, useUpdateConversation, type Conversation } from './api'

export function useChatMenu(conv: Conversation | undefined, opts: { onDeleted?: () => void } = {}): { actions: MenuAction[]; dialogs: ReactNode; error: string | null } {
  const { connection } = useSession()
  const update = useUpdateConversation()
  const del = useDeleteConversation()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  if (!conv) return { actions: [], dialogs: null, error: null }
  const patch = (body: Parameters<typeof update.mutate>[0]['body'], done?: () => void) => update.mutate({ id: conv.id, body }, { onSuccess: done, onError: (err) => toast((err as Error).message, { tone: 'error' }) })
  // Archiving takes the chat out of sight: say so, with a way back.
  const archive = (archived: boolean) =>
    patch({ archived }, () => toast(archived ? 'Chat archived' : 'Chat back in your chats', { action: { label: 'Undo', run: () => update.mutate({ id: conv.id, body: { archived: !archived } }) } }))
  const actions: MenuAction[] = [
    ...(conv.temporary ? [{ label: 'Keep chat', icon: <Save />, onSelect: () => patch({ temporary: false }, () => toast('Chat kept')) }] : []),
    { label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(true) },
    conv.pinned
      ? { label: 'Remove from favorites', icon: <StarOff />, onSelect: () => patch({ pinned: false }) }
      : { label: 'Add to favorites', icon: <Star />, onSelect: () => patch({ pinned: true }) },
    conv.archived
      ? { label: 'Unarchive', icon: <ArchiveRestore />, onSelect: () => archive(false) }
      : { label: 'Archive', icon: <Archive />, onSelect: () => archive(true) },
    { label: 'Open in Anemo', icon: <ExternalLink />, onSelect: () => void chrome.tabs.create({ url: `${connection.serverUrl}/c/${conv.id}` }) },
    { label: 'Delete', icon: <Trash2 />, danger: true, separated: true, onSelect: () => setDeleting(true) },
  ]
  const dialogs = (
    <>
      <PromptDialog open={renaming} onOpenChange={setRenaming} title="Rename chat" label="Title" initial={conv.title} confirmLabel="Rename" onConfirm={(title) => patch({ title })} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this chat?"
        body={<>“{conv.title}” is deleted in Anemo too, with its messages. This can’t be undone.</>}
        confirmLabel="Delete"
        danger
        onConfirm={() => del.mutate(conv.id, { onSuccess: () => { toast('Chat deleted'); opts.onDeleted?.() }, onError: (err) => toast((err as Error).message, { tone: 'error' }) })}
      />
    </>
  )
  const failed = update.error ?? del.error
  return { actions, dialogs, error: failed ? (failed as Error).message : null }
}
