/**
 * Tags that name a value of another property (the tag `ludmyla-doula` on items that are
 * for the client Ludmyla Doula), offered as a suggestion: turning one into the value
 * gives every item with the tag that value and removes the tag. Nothing changes until
 * the user applies it; a dismissed one isn't offered again.
 */
import { useState } from 'react'
import { Tags } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { NoticeButton } from '@/components/ui/NoticeButton'
import { toast } from '@/components/ui/toast'
import { plural, t } from '@/lib/i18n'
import { itemsText, useApplyTagSuggestion, useDismissTagSuggestion, useTagSuggestions } from './api'

export function TagSuggestionsReview() {
  const suggestions = useTagSuggestions()
  const apply = useApplyTagSuggestion()
  const dismiss = useDismissTagSuggestion()
  const [open, setOpen] = useState(false)
  const list = suggestions.data ?? []
  if (list.length === 0) return null
  const fail = (err: unknown) => toast({ message: errorMessage(err) })
  const busy = apply.isPending || dismiss.isPending
  return (
    <>
      <NoticeButton icon={<Tags />} onClick={() => setOpen(true)}>
        {plural(list.length, '{n} tag could become a property value', '{n} tags could become property values')}
      </NoticeButton>
      <Dialog open={open} onOpenChange={setOpen} className="md:w-[min(94vw,680px)]" title={t('Tags that name a value')}
        description={t('These tags name a value of another property, such as a client. Turning one into the value gives everything with the tag that value and removes the tag (documents get a revision).')}>
        <ul className="flex max-h-[60vh] flex-col overflow-auto">
          {list.map((s) => (
            <li key={`${s.tag}:${s.key}:${s.value}`} className="flex flex-wrap items-center gap-2 border-t border-border py-2.5 first:border-t-0">
              <div className="min-w-48 flex-1">
                <div className="text-[13.5px]">
                  {t('Tag {tag} to {property}: {value}', { tag: s.tag, property: s.property_label, value: s.value_label })}
                </div>
                <div className="text-[12px] text-muted">{itemsText(s)}{s.titles.length ? ` · ${s.titles.join(', ')}` : ''}</div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismiss.mutate(s, { onError: fail })}>{t('Dismiss')}</Button>
              <Button size="sm" variant="primary" disabled={busy}
                onClick={() => apply.mutate(s, {
                  onError: fail,
                  onSuccess: (r) => toast({
                    message: r.failed.length
                      ? t('Done, except: {items}', { items: r.failed.join('; ') })
                      : t('{items} now have {property}: {value}.', { items: itemsText(r), property: s.property_label, value: s.value_label }),
                  }),
                })}>
                {t('Turn into the value')}
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  )
}
