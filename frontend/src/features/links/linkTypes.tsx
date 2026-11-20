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

/** "in the trash" / "broken link" for a link whose item is gone, else null. */
export function linkState(link: { state: string }): string | null {
  if (link.state === 'in_trash') return t('in the trash')
  if (link.state === 'deleted') return t('broken link')
  return null
}
