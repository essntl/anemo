/** How each kind of search hit is named and drawn. */
import { Brain, CalendarDays, CheckSquare, Clock, FileText, FolderOpen, type LucideIcon, MessageSquare } from 'lucide-react'
import type { SearchKind } from './api'

export const KINDS: { kind: SearchKind; label: string; icon: LucideIcon }[] = [
  { kind: 'chat', label: 'Chats', icon: MessageSquare },
  { kind: 'document', label: 'Documents', icon: FileText },
  { kind: 'memory', label: 'Memory', icon: Brain },
  { kind: 'task', label: 'Tasks', icon: CheckSquare },
  { kind: 'event', label: 'Calendar', icon: CalendarDays },
  { kind: 'file', label: 'Files', icon: FolderOpen },
  { kind: 'automation', label: 'Automations', icon: Clock },
]

export const kindInfo = (kind: SearchKind) => KINDS.find((k) => k.kind === kind) ?? KINDS[0]
