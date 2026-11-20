/**
 * On the hub page of a property value (a client's page): a generated list of every
 * document with that value. Nothing is moved or copied; the list follows the
 * properties.
 */
import { Link } from 'react-router'
import { FileText } from 'lucide-react'
import { formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useHub } from '../api'

export function HubList({ documentId }: { documentId: string }) {
  const hub = useHub(documentId)
  const sections = hub.data ?? []
  if (sections.length === 0) return null
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
            <ul className="flex flex-col">
              {s.rows.map((row) => (
                <li key={row.id}>
                  <Link to={row.url} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] hover:bg-surface-hover">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                    <span className="shrink-0 text-[11.5px] text-subtle">{formatWhen(row.updated_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  )
}
