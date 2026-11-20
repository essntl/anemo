import type { Schemas } from '@/api/client'
import { t } from '@/lib/i18n'

/** Who made or changed something (the server's ActorOut). */
export type Actor = Schemas['ActorOut']

/** The source fields that tasks and events share. */
export interface Synced {
  source?: string | null
  external_key?: string | null
  source_url?: string | null
  synced_at?: string | null
  edited_by_user_at?: string | null
}

/** Whether an item came from an outside system (an automation syncs it). */
export const isSynced = (item: Synced): boolean => Boolean(item.source || item.external_key)

/** A short name for who saved something, as plain text (a revision in a list). */
export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'chat':
      return actor.url ? t('Assistant in “{name}”', { name: actor.label }) : t('Assistant in a deleted chat')
    case 'automation':
      return actor.url ? t('Automation “{name}”', { name: actor.label }) : t('A deleted automation')
    case 'external':
      return t('Outside the app')
    default:
      return t('You')
  }
}
