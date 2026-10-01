/** Add or edit a place notifications are sent to (a Discord channel's webhook). */
import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Input'
import { type Destination, type DestinationForm, KIND_LABELS, type NotificationKind, useSaveDestination } from '../api'

const KINDS = Object.keys(KIND_LABELS) as NotificationKind[]

export function DestinationDialog({ destination, onClose }: { destination: Destination | null; onClose: () => void }) {
  const save = useSaveDestination()
  const [form, setForm] = useState<DestinationForm>({
    name: destination?.name ?? '',
    url: '',
    enabled: destination?.enabled ?? true,
    kinds: (destination?.kinds as NotificationKind[] | undefined) ?? KINDS,
  })
  const valid = form.name.trim() !== '' && (destination !== null || form.url.trim() !== '')
  const toggle = (kind: NotificationKind, on: boolean) =>
    setForm({ ...form, kinds: on ? [...form.kinds, kind] : form.kinds.filter((k) => k !== kind) })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,520px)]"
      title={destination ? `Edit “${destination.name}”` : 'Add a Discord channel'}
      description="In Discord: channel settings › Integrations › Webhooks › New Webhook › Copy Webhook URL."
      footer={
        <>
          {save.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid}
            onClick={() => save.mutate({ id: destination?.id, form }, { onSuccess: onClose })}>
            {destination ? 'Save' : 'Add'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={form.name} maxLength={100} placeholder="e.g. My Discord" autoFocus={!destination}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Webhook URL"
          hint={destination
            ? `Saved (ends in ${destination.url_hint?.replace(/•/g, '') ?? '…'}). Leave empty to keep it.`
            : 'Stored encrypted and never shown again. Anyone with this URL can post to the channel.'}>
          <Input type="password" autoComplete="off" value={form.url}
            placeholder={destination ? 'Paste a new URL to replace it' : 'https://discord.com/api/webhooks/…'}
            onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Send here</legend>
          <div className="flex flex-col gap-0.5">
            {KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover pointer-coarse:py-2.5">
                <input type="checkbox" className="accent-[var(--accent)]" checked={form.kinds.includes(kind)}
                  onChange={(e) => toggle(kind, e.target.checked)} />
                {KIND_LABELS[kind]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[12px] text-muted">An automation can also be set to send its results to specific channels.</p>
        </fieldset>
      </div>
    </Dialog>
  )
}
