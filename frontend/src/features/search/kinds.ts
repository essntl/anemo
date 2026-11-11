/** How each kind of search hit is named and drawn. */
import { Brain, CalendarDays, CheckSquare, Clock, FileText, FolderOpen, type LucideIcon, MessageSquare } from 'lucide-react'
import type { SearchKind } from './api'
import { msg } from '@/lib/i18n'

export const KINDS: { kind: SearchKind; label: string; icon: LucideIcon }[] = [
  { kind: 'chat', label: msg('Chats'), icon: MessageSquare },
  { kind: 'document', label: msg('Documents'), icon: FileText },
  { kind: 'memory', label: msg('Memory'), icon: Brain },
  { kind: 'task', label: msg('Tasks'), icon: CheckSquare },
  { kind: 'event', label: msg('Calendar'), icon: CalendarDays },
  { kind: 'file', label: msg('Files'), icon: FolderOpen },
  { kind: 'automation', label: msg('Automations'), icon: Clock },
]

export const kindInfo = (kind: SearchKind) => KINDS.find((k) => k.kind === kind) ?? KINDS[0]
