import { useNavigate, useParams } from 'react-router'
import { Archive, ArchiveRestore, Download, FileText, FolderInput, Link2, Pencil, Save, Star, StarOff, Tags, Trash2 } from 'lucide-react'
import { create } from 'zustand'
import { errorMessage } from '@/api/client'
import type { MenuAction } from '@/components/ui/ActionMenu'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { useShareDialog } from '@/features/shares/shareStore'
import { t } from '@/lib/i18n'
import { type Conversation, useDeleteConversation, useSaveAsDocument, useUpdateConversation } from './api'

/** "work, ideas" -> ["work", "ideas"]. The server tidies them further (lowercase, no #). */
export function parseTags(text: string): string[] {
  return text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)
}

/** Which chats the "Move to project" dialog is open for (one from a menu, several from the overview). */
interface MoveState {
  ids: string[] | null
  current: string | null
  ask: (ids: string[], current?: string | null) => void
  close: () => void
}

export const useMoveChats = create<MoveState>((set) => ({
  ids: null,
  current: null,
  ask: (ids, current = null) => set({ ids, current }),
  close: () => set({ ids: null }),
}))

/**
 * Everything you can do with one chat, as menu entries. Used by the sidebar list,
 * the all-chats overview and the chat's own header, so they always offer the same.
 */
export function useChatActions(conv: Conversation): MenuAction[] {
  const navigate = useNavigate()
  const { conversationId } = useParams()
  const update = useUpdateConversation()
  const remove = useDeleteConversation()
  const saveDocument = useSaveAsDocument()
  const askMove = useMoveChats((s) => s.ask)
  const askShare = useShareDialog((s) => s.ask)

  const rename = async () => {
    const title = await promptDialog({ title: t('Rename chat'), label: t('Title'), initial: conv.title, confirmLabel: t('Rename') })
    if (title) update.mutate({ id: conv.id, body: { title } })
  }
  const editTags = async () => {
    const text = await promptDialog({
      title: t('Tags'), label: t('Tags, separated by commas'), initial: conv.tags.join(', '),
      placeholder: t('e.g. ideas, travel'), confirmLabel: t('Save'), allowEmpty: true,
    })
    if (text !== null) update.mutate({ id: conv.id, body: { tags: parseTags(text) } })
  }
  const saveAsDocument = () =>
    saveDocument.mutate(conv.id, {
      onSuccess: (doc) =>
        toast({ message: t('Saved as {path}', { path: doc.path }), duration: 10_000, action: { label: t('Open'), onClick: () => void navigate(`/documents/${doc.document_id}`) } }),
      onError: (err) => toast({ message: errorMessage(err) }),
    })
  const del = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{title}”?', { title: conv.title }), message: t('The chat and its attachments are deleted. This cannot be undone.'),
      confirmLabel: t('Delete'), danger: true,
    })
    if (!ok) return
    // mutateAsync: the row this was started from may be gone before the answer arrives.
    void remove.mutateAsync(conv.id).then(
      () => conversationId === conv.id && navigate('/'),
      (err: unknown) => toast({ message: errorMessage(err) }),
    )
  }

  return [
    // A temporary chat is deleted a few minutes after its last message unless kept.
    ...(conv.temporary
      ? [{ label: t('Keep chat'), icon: <Save />, onSelect: () => update.mutate({ id: conv.id, body: { temporary: false } }) }]
      : []),
    { label: t('Rename'), icon: <Pencil />, onSelect: () => void rename() },
    conv.pinned
      ? { label: t('Remove from favorites'), icon: <StarOff />, onSelect: () => update.mutate({ id: conv.id, body: { pinned: false } }) }
      : { label: t('Add to favorites'), icon: <Star />, onSelect: () => update.mutate({ id: conv.id, body: { pinned: true } }) },
    { label: t('Move to project'), icon: <FolderInput />, onSelect: () => askMove([conv.id], conv.project_id ?? null) },
    { label: t('Tags'), icon: <Tags />, onSelect: () => void editTags() },
    conv.archived
      ? { label: t('Unarchive'), icon: <ArchiveRestore />, onSelect: () => update.mutate({ id: conv.id, body: { archived: false } }) }
      : { label: t('Archive'), icon: <Archive />, onSelect: () => update.mutate({ id: conv.id, body: { archived: true } }) },
    { label: t('Share'), icon: <Link2 />, onSelect: () => askShare({ kind: 'chat', id: conv.id, title: conv.title }) },
    { label: t('Download as Markdown'), icon: <Download />, download: `/api/conversations/${conv.id}/export` },
    { label: t('Save as document'), icon: <FileText />, onSelect: saveAsDocument },
    { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void del() },
  ]
}
