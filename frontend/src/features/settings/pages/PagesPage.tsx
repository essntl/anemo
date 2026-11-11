/**
 * Settings > Pages: where each page of the app goes. In the sidebar's list, behind
 * "More", or off; and in what order. Saved at once (settings section `navigation`).
 */
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { msg, t } from '@/lib/i18n'
import { useSaveSection } from '../api'
import {
  ALWAYS_ON, DEFAULT_NAVIGATION, movePage, type Navigation, PAGE_INFO, type PageId, type Place, PLACES, shiftPage, useNavigation,
} from '../navigation'

const PLACE_LABEL: Record<Place, string> = { pinned: msg('Sidebar'), more: msg('More'), off: msg('Off') }
const PLACE_HINT: Record<Place, string> = {
  pinned: msg('Always in the list on the left.'),
  more: msg('One click away, behind “More”.'),
  off: msg('Not part of your Anemo: in no menu and not in search.'),
}
const ARROW = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-30 pointer-coarse:h-10 pointer-coarse:w-10'

function PageRow({ id, index, count, place, onMove, onShift }: {
  id: PageId
  index: number
  count: number
  place: Place
  onMove: (place: Place) => void
  onShift: (by: -1 | 1) => void
}) {
  const { icon: Icon, label, title } = PAGE_INFO[id]
  const name = t(title ?? label)
  const places = ALWAYS_ON.includes(id) ? PLACES.filter((p) => p !== 'off') : PLACES
  return (
    <li className="flex items-center gap-2 py-1.5">
      <Icon className={cn('h-[17px] w-[17px] shrink-0', place === 'off' ? 'text-subtle' : 'text-muted')} aria-hidden />
      <span data-page-name className={cn('min-w-0 flex-1 truncate text-[13.5px] font-medium', place === 'off' && 'text-muted')}>{name}</span>
      {place !== 'off' && (
        <>
          <button type="button" className={ARROW} disabled={index === 0} onClick={() => onShift(-1)}
            aria-label={t('Move {page} up', { page: name })} title={t('Move up')}>
            <ArrowUp className="h-4 w-4" />
          </button>
          <button type="button" className={ARROW} disabled={index === count - 1} onClick={() => onShift(1)}
            aria-label={t('Move {page} down', { page: name })} title={t('Move down')}>
            <ArrowDown className="h-4 w-4" />
          </button>
        </>
      )}
      <Select className="w-40 shrink-0" aria-label={t('Where {page} goes', { page: name })} value={place}
        onValueChange={(v) => onMove(v as Place)}
        options={places.map((p) => ({ value: p, label: t(PLACE_LABEL[p]) }))} />
    </li>
  )
}

export function PagesPage() {
  const navigation = useNavigation()
  const save = useSaveSection('navigation')
  const change = (next: Navigation) => {
    if (next !== navigation) save.mutate(next)
  }
  const isDefault = JSON.stringify(navigation) === JSON.stringify(DEFAULT_NAVIGATION)
  const withTools = (Object.keys(PAGE_INFO) as PageId[]).filter((id) => PAGE_INFO[id].hasTools).map((id) => t(PAGE_INFO[id].label)).join(', ')

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title={t('Pages')}
          description={t('Choose which pages are in the sidebar, which wait behind “More”, and which you don’t use at all.')}
          actions={
            <Button size="sm" variant="secondary" className="shrink-0" icon={<RotateCcw className="h-3.5 w-3.5" />}
              disabled={isDefault} onClick={() => change(DEFAULT_NAVIGATION)}>
              {t('Reset')}
            </Button>
          } />
        <CardBody className="flex flex-col gap-5">
          {PLACES.map((place) => (
            <section key={place} aria-label={t(PLACE_LABEL[place])}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{t(PLACE_LABEL[place])}</h4>
              <p className="mt-0.5 text-[12.5px] text-muted">{t(PLACE_HINT[place])}</p>
              {navigation[place].length === 0 ? (
                <p className="mt-2 rounded-control border border-dashed border-border px-3 py-2.5 text-[13px] text-subtle">
                  {place === 'off' ? t('Every page is on.') : t('No pages here.')}
                </p>
              ) : (
                <ul className="mt-1.5 divide-y divide-border">
                  {navigation[place].map((id, index) => (
                    <PageRow key={id} id={id} index={index} count={navigation[place].length} place={place}
                      onMove={(to) => change(movePage(navigation, id, to))}
                      onShift={(by) => change(shiftPage(navigation, id, by))} />
                  ))}
                </ul>
              )}
            </section>
          ))}
          {save.isError && <p className="text-[13px] text-error">{errorMessage(save.error)}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('What turning a page off does')} />
        <CardBody className="flex flex-col gap-2 text-[13px] text-muted">
          <p>{t('The page leaves the sidebar, the phone menu and the search box, its widgets leave Home, and its address leads Home. Nothing is deleted: turn it back on and everything is as you left it.')}</p>
          <p>{t('Agents lose the tools of these pages when they are off, and are not told about them: {pages}. This applies from the next message on.', { pages: withTools })}</p>
          <p>{t('Home and the Inbox stay on: the app opens on Home, and approvals wait in the Inbox.')}</p>
          <p className="md:hidden">{t('On a phone, Home and the Inbox are tabs at the bottom; the other pages are under “More” in this order.')}</p>
        </CardBody>
      </Card>
    </div>
  )
}
