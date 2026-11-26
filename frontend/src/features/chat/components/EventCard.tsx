/**
 * A turn an event added to the chat ("wake me", docs/specs/16-event-triggers.md): the
 * assistant had asked to be woken when something happens, and it did. Not the user's
 * words, so not a bubble on the right: a card in the middle that says what happened.
 */
import { Zap } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { formatWhen } from '@/lib/format'
import { plural, t } from '@/lib/i18n'

type EventSummary = Schemas['EventSummary']

export function EventCard({ event }: { event: EventSummary }) {
  return (
    <div className="flex justify-center" role="note" aria-label={t('An event woke this chat')}>
      <div className="flex max-w-[90%] items-start gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-[13px]">
        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <div className="font-medium">{t('An event woke this chat')}</div>
          <div className="break-words text-subtle">{event.summary}</div>
          <div className="text-[12px] text-muted">
            {formatWhen(event.at)}
            {(event.coalesced ?? 1) > 1 && <> · {plural(event.coalesced ?? 1, '{n} event in a short time', '{n} events in a short time')}</>}
          </div>
        </div>
      </div>
    </div>
  )
}
