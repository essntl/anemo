/**
 * On the hub page of a property value (a client's page): a generated list of every
 * document, task and event with that value, grouped by type, and everything that links
 * to the hub itself. Nothing is moved or copied; the list follows the properties and
 * the links.
 */
import { Link } from 'react-router'
import { allLinks, useLinks } from '@/features/links/api'
import { TYPE_ICONS } from '@/features/links/linkTypes'
import { formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useHub } from '../api'
import { hubGroups } from '../hub'

const ROW = 'flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] hover:bg-surface-hover [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:text-muted'

export function HubList({ documentId }: { documentId: string }) {
  const hub = useHub(documentId)
  const sections = hub.data ?? []
  const links = useLinks('document', sections.length ? documentId : null)
  if (sections.length === 0) return null
  const listed = new Set(sections.flatMap((s) => s.rows.map((r) => r.url)))
  const linkedHere = allLinks(links.data?.backlinks).filter((l) => !listed.has(l.ref))
  return (
    <section aria-label={t('Everything with this value')} className="shrink-0 border-t border-border px-4 py-3">
      {sections.map((s) => (
        <div key={`${s.key}:${s.value}`} className="mb-2 last:mb-0">
          <h3 className="mb-1 text-[12px] font-semibold text-muted">
            {t('Everything with {property}: {value}', { property: s.property_label, value: s.label })}
          </h3>
          {s.rows.length === 0 ? (
            <p className="text-[12.5px] text-muted">{t('Nothing else has this value yet.')}</p>
          ) : (
            hubGroups(s.rows).map((g) => (
              <div key={g.type} className="mb-1">
                <div className="px-1.5 text-[11px] text-subtle">{t(g.label)}</div>
                <ul className="flex flex-col">
                  {g.rows.map((row) => (
                    <li key={row.id}>
                      <Link to={row.url} className={ROW}>
                        {TYPE_ICONS[row.type]}
                        <span className="min-w-0 flex-1 truncate">{row.title}</span>
                        <span className="shrink-0 text-[11.5px] text-subtle">{formatWhen(row.updated_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      ))}
      {linkedHere.length > 0 && (
        <div className="mt-2">
          <h3 className="mb-1 text-[12px] font-semibold text-muted">{t('Linked to this page')}</h3>
          <ul className="flex flex-col">
            {linkedHere.map((l) => (
              <li key={`${l.type}:${l.id}`}>
                <Link to={l.ref} className={ROW}>
                  {TYPE_ICONS[l.type]}
                  <span className="min-w-0 flex-1 truncate">{l.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
