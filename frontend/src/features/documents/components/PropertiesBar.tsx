/**
 * The document's properties, above its text (the editor hides the front matter they
 * are stored in). Each value is a chip; a click edits it. Every change is saved by the
 * server into the file's front matter, as a revision, and the editor picks up the new
 * text.
 *
 * When the front matter can't be read, a warning says why instead: the text is saved
 * as it is, and the properties can be fixed in the Markdown editor.
 */
import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { AlertTriangle, Check, Plus, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/toast'
import {
  type PropertyDefinition,
  type PropertyValue,
  propertiesFor,
  suggestionsOf,
  useProperties,
  valueLabel,
} from '@/features/properties/api'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type DocumentContent, useSetProperties } from '../api'

interface Props {
  doc: DocumentContent
  projectId: string | null
  /** The version the editor has (sent along, so a change made elsewhere isn't overwritten). */
  baseHash: () => string
  /** Saves what is typed first. */
  flush: () => Promise<boolean>
}

const CHIP = 'inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-surface-2 px-2.5 text-[12px] hover:bg-surface-hover'

export function PropertiesBar({ doc, projectId, baseHash, flush }: Props) {
  const properties = useProperties()
  const set = useSetProperties(doc.id)
  const [editing, setEditing] = useState<string | null>(null)
  const available = propertiesFor(properties.data ?? [], projectId)
  const values = doc.properties ?? {}
  const shown = available.filter((p) => p.key in values)
  const unused = available.filter((p) => !(p.key in values))

  const change = async (key: string, value: PropertyValue | null) => {
    if (!(await flush())) return
    try {
      await set.mutateAsync({ set: { [key]: value }, baseHash: baseHash() })
      setEditing(null)
    } catch (err) {
      const near = suggestionsOf(err)
      toast({ message: near.length ? t('{message} Use: {values}', { message: errorMessage(err), values: near.join(', ') }) : errorMessage(err) })
    }
  }

  if (doc.properties_error) {
    return (
      <div role="status" className="flex items-start gap-2 border-b border-warning/40 bg-warning/8 px-4 py-2 text-[13px]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          {t('The properties at the top of this file can’t be read, so the document has none for now. Its text is saved. Fix them in the Markdown editor:')}{' '}
          <span className="text-muted">{doc.properties_error}</span>
        </span>
      </div>
    )
  }
  if (!properties.data) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5" aria-label={t('Properties')}>
      {shown.map((p) => (
        <PropertyPopover key={p.key} definition={p} value={values[p.key] as PropertyValue} open={editing === p.key}
          onOpenChange={(open) => setEditing(open ? p.key : null)} onChange={(v) => void change(p.key, v)} busy={set.isPending}>
          <button type="button" className={CHIP} title={t('Change {property}', { property: p.label })}>
            <span className="text-muted">{p.label}:</span>
            <span className="truncate font-medium">{valueLabel(p, values[p.key])}</span>
          </button>
        </PropertyPopover>
      ))}
      {unused.length > 0 && (
        <AddProperty unused={unused} busy={set.isPending} onChange={(key, v) => void change(key, v)} />
      )}
    </div>
  )
}

/** "+ Property": pick one the document doesn't have yet, then its value. */
function AddProperty({ unused, busy, onChange }: { unused: PropertyDefinition[]; busy: boolean; onChange: (key: string, value: PropertyValue) => void }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<PropertyDefinition | null>(null)
  const close = (next: boolean) => {
    setOpen(next)
    if (!next) setPicked(null)
  }
  return (
    <Popover.Root open={open} onOpenChange={close}>
      <Popover.Trigger asChild>
        <button type="button" className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-text">
          <Plus className="h-3.5 w-3.5" /> {t('Property')}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-64 rounded-panel border border-border bg-surface p-1.5 shadow-float">
          {picked ? (
            <ValueEditor definition={picked} value={null} busy={busy} onChange={(v) => { onChange(picked.key, v as PropertyValue); close(false) }} />
          ) : (
            <ul className="flex flex-col" aria-label={t('Add a property')}>
              {unused.map((p) => (
                <li key={p.key}>
                  <button type="button" onClick={() => (p.type === 'checkbox' ? (onChange(p.key, true), close(false)) : setPicked(p))}
                    className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-hover">
                    {p.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

interface PopoverProps {
  definition: PropertyDefinition
  value: PropertyValue
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: PropertyValue | null) => void
  busy: boolean
  children: React.ReactNode
}

function PropertyPopover({ definition, value, open, onOpenChange, onChange, busy, children }: PopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-64 rounded-panel border border-border bg-surface p-1.5 shadow-float">
          <ValueEditor definition={definition} value={value} busy={busy} onChange={onChange} />
          <button type="button" onClick={() => onChange(null)}
            className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-error hover:bg-surface-hover">
            <X className="h-3.5 w-3.5" /> {t('Remove {property}', { property: definition.label })}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Picks or types the value, by the property's type. */
function ValueEditor({ definition, value, busy, onChange }: { definition: PropertyDefinition; value: PropertyValue | null; busy: boolean; onChange: (value: PropertyValue) => void }) {
  const [text, setText] = useState(value === null || Array.isArray(value) ? '' : String(value))
  if (definition.type === 'select' || definition.type === 'multi_select') {
    const multi = definition.type === 'multi_select'
    const current = Array.isArray(value) ? value : value ? [String(value)] : []
    const pick = (slug: string) => {
      if (!multi) return onChange(slug)
      onChange(current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug])
    }
    return (
      <div className="flex flex-col">
        <ul className="flex max-h-64 flex-col overflow-y-auto" aria-label={definition.label}>
          {definition.options.map((o) => (
            <li key={o.id}>
              <button type="button" disabled={busy} onClick={() => pick(o.slug)} aria-pressed={current.includes(o.slug)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-hover">
                <Check className={cn('h-3.5 w-3.5 shrink-0', current.includes(o.slug) ? 'text-accent' : 'invisible')} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </button>
            </li>
          ))}
          {definition.options.length === 0 && <li className="px-2 py-1.5 text-[12.5px] text-muted">{t('No values yet')}</li>}
        </ul>
        {definition.open_vocabulary && (
          <form className="mt-1 flex gap-1 border-t border-border pt-1.5"
            onSubmit={(e) => { e.preventDefault(); if (text.trim()) onChange(multi ? [...current, text.trim()] : text.trim()) }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('New tag')} aria-label={t('New tag')} className="h-8" />
            <Button size="sm" type="submit" disabled={!text.trim() || busy}>{t('Add')}</Button>
          </form>
        )}
      </div>
    )
  }
  if (definition.type === 'checkbox') {
    return (
      <button type="button" onClick={() => onChange(!value)} className="flex w-full rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-hover">
        {value ? t('Turn off') : t('Turn on')}
      </button>
    )
  }
  const inputType = definition.type === 'date' ? 'date' : definition.type === 'number' ? 'number' : 'text'
  return (
    <form className="flex gap-1 p-0.5" onSubmit={(e) => {
      e.preventDefault()
      if (text.trim()) onChange(definition.type === 'number' ? Number(text) : text.trim())
    }}>
      <Input type={inputType} value={text} onChange={(e) => setText(e.target.value)} aria-label={definition.label} className="h-8" autoFocus />
      <Button size="sm" type="submit" disabled={!text.trim() || busy}>{t('Save')}</Button>
    </form>
  )
}
