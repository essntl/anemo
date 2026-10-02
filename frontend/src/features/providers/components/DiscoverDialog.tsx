import { useMemo, useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { type Provider, useDiscover, useImportModels } from '../api'
import { CapabilityChips, CapabilityInfo } from './CapabilityChips'

/** Lists the models a provider offers and imports the selected ones. */
export function DiscoverDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: Provider
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const discover = useDiscover(provider.id, open)
  const importModels = useImportModels()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (discover.data ?? []).filter(
      (m) => !q || m.model_key.toLowerCase().includes(q) || m.display_name?.toLowerCase().includes(q),
    )
  }, [discover.data, filter])

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const submit = async () => {
    await importModels.mutateAsync({ providerId: provider.id, keys: [...selected] })
    setSelected(new Set())
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Models from ${provider.name}`}
      description="Pick the models you want to use. You can adjust their capabilities afterwards."
      className="md:w-[min(94vw,640px)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={selected.size === 0} loading={importModels.isPending} onClick={submit}>
            Add {selected.size || ''} model{selected.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <Input placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="mt-3 max-h-[50vh] overflow-y-auto rounded-control border border-border">
        {discover.isPending && <p className="p-4 text-[13px] text-muted">Asking the provider…</p>}
        {discover.isError && <p className="p-4 text-[13px] text-error">{errorMessage(discover.error)}</p>}
        {discover.data && visible.length === 0 && <p className="p-4 text-[13px] text-muted">No models match.</p>}
        {visible.map((m) => (
          // The tags sit outside the label, so pressing the phone's info button
          // does not also tick the model.
          <div key={m.model_key} className="flex items-center gap-1 border-b border-border pr-1 last:border-0 hover:bg-surface-hover md:pr-3">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-3">
              <Checkbox
                disabled={m.already_added}
                checked={m.already_added || selected.has(m.model_key)}
                onChange={() => toggle(m.model_key)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{m.display_name ?? m.model_key}</div>
                <div className="truncate font-mono text-[11px] text-muted">
                  {m.model_key}
                  {m.context_window ? ` · ${Math.round(m.context_window / 1000)}k context` : ''}
                  {m.already_added ? ' · added' : ''}
                </div>
              </div>
            </label>
            <div className="hidden shrink-0 md:block">
              <CapabilityChips capabilities={m.capabilities} />
            </div>
            <div className="md:hidden">
              <CapabilityInfo name={m.display_name ?? m.model_key} capabilities={m.capabilities} />
            </div>
          </div>
        ))}
      </div>
      {importModels.isError && <p className="mt-2 text-[13px] text-error">{errorMessage(importModels.error)}</p>}
    </Dialog>
  )
}
