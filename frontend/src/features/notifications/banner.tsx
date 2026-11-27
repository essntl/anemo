import { AlarmClock, Bell, Bot, Clock, ShieldQuestion, SquareTerminal, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ToastLevel, ToastOptions } from '@/components/ui/toast'
import { msg, t } from '@/lib/i18n'

/** A notification as the app's event stream sends it (`notification`). */
export interface NotificationEvent {
  id: string
  title: string
  body: string
  link: string | null
  kind?: string
  level?: string
}

const KIND_ICON: Record<string, ReactNode> = {
  reminder: <AlarmClock />,
  automation: <Clock />,
  approval: <ShieldQuestion />,
  agent: <Bot />,
  focus: <Timer />,
}
const LEVELS: readonly string[] = ['info', 'success', 'warning', 'error']

/** The action's words for where the notification leads. */
const ACTIONS: [prefix: string, label: string][] = [
  ['/c/', msg('Open chat')],
  ['/code/', msg('View job')],
  ['/runs/', msg('View run')],
  ['/documents/', msg('Open document')],
  ['/tasks', msg('Open tasks')],
  ['/automations', msg('Open automations')],
]

export function actionLabel(link: string): string {
  const found = ACTIONS.find(([prefix]) => link.startsWith(prefix))
  return found ? t(found[1]) : t('Open')
}

/** The body as one or two lines of plain text: Markdown marks and line breaks go. */
export function plainText(body: string, max = 200): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * How an in-app notification shows as a banner: its title, a line or two of its text,
 * its level as the accent and an icon for what it is about (a finished Claude Code job
 * links to /code/…), and an action named for where it leads ("Open chat", "View job").
 */
export function notificationToast(note: NotificationEvent, open: () => void): ToastOptions {
  const level = LEVELS.includes(note.level ?? '') ? (note.level as ToastLevel) : 'info'
  const icon = note.link?.startsWith('/code/') ? <SquareTerminal /> : (KIND_ICON[note.kind ?? ''] ?? <Bell />)
  return {
    title: note.title,
    message: plainText(note.body ?? ''),
    level,
    icon,
    duration: level === 'error' || level === 'warning' ? 15_000 : 10_000,
    action: { label: note.link ? actionLabel(note.link) : t('Open Inbox'), onClick: open },
  }
}
