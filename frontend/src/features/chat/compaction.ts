import { formatCount } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { ChatContext } from './api'

/** The composer's `/compact [focus]` (docs/specs/24-chat-compaction.md): null for any
 *  other text, else what to keep in detail (null: nothing in particular). */
export function parseCompact(text: string): { focus: string | null } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const focus = match[1]?.trim()
  return { focus: focus ? focus : null }
}

/** Where the chat is compacted shows from here on (a share of the threshold). */
export const WARN_SHARE = 0.85

/** The line under the composer about the chat's size, or null while it is small (or
 *  Claude Code compacts it itself). */
export function contextWarning(context: ChatContext | undefined): string | null {
  if (!context || context.compacts_itself) return null
  const { tokens, compact_at: at, auto_compact: auto } = context
  if (tokens < at * WARN_SHARE) return null
  const vars = { tokens: formatCount(tokens), at: formatCount(at) }
  if (!auto) return t('This chat is at {tokens} tokens. /compact summarizes it.', vars)
  if (tokens >= at) return t('This chat will be compacted before your next message.')
  return t('This chat is at {tokens} of {at} tokens: it will be compacted when it passes {at} (/compact does it now).', vars)
}
