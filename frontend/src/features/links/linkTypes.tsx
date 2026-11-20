/** How the types of linked items show: their icons and group names. */
import type { ReactNode } from 'react'
import { CalendarDays, FileText, MessageSquare, SquareCheckBig } from 'lucide-react'
import { msg, t } from '@/lib/i18n'
import type { LinkType } from './api'

export const TYPE_ICONS: Record<LinkType, ReactNode> = {
  document: <FileText />,
  task: <SquareCheckBig />,
  event: <CalendarDays />,
  chat: <MessageSquare />,
}

export const GROUP_LABELS: Record<LinkType, string> = {
  document: msg('Documents'),
  task: msg('Tasks'),
  event: msg('Events'),
  chat: msg('Chats'),
}

/**
 * "in the trash" / "deleted for good" (a task or event) / "removed" (a document or
 * chat) for a link whose item is gone, else null.
 */
export function linkState(link: { state: string; type: string }): string | null {
  if (link.state === 'in_trash') return t('in the trash')
  if (link.state !== 'deleted') return null
  return link.type === 'task' || link.type === 'event' ? t('deleted for good') : t('removed')
}

/** The labels of the values an item can't keep in its project (they go when it is saved). */
export function droppedLabels(
  values: Record<string, unknown>,
  allowed: { key: string }[],
  all: { key: string; label: string }[],
): string[] {
  const keys = new Set(allowed.map((p) => p.key))
  return Object.keys(values)
    .filter((key) => key !== 'tags' && !keys.has(key))
    .map((key) => all.find((p) => p.key === key)?.label ?? key)
}
