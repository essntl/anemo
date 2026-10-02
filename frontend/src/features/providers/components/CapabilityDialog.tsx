import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Switch } from '@/components/ui/Switch'
import { type Model, useUpdateModel } from '../api'

/** What each switch means, in the order shown. Embedding models are a different kind
 *  of model, so that is not a switch here. */
const OPTIONS: { key: string; label: string; hint: string }[] = [
  { key: 'tools', label: 'Tools', hint: 'Needed for Agent mode and for remembering things in chats.' },
  { key: 'vision', label: 'Vision', hint: 'Can look at images you attach.' },
  { key: 'pdf', label: 'PDF', hint: 'Reads PDF files directly. When off, their text is extracted first.' },
  { key: 'reasoning', label: 'Reasoning', hint: 'Thinks before answering, where the provider supports it.' },
  { key: 'structured_output', label: 'JSON output', hint: 'Can be made to answer in a fixed JSON shape.' },
]

/**
 * Lets you correct what Anemo assumes a model can do. Most providers do not say, so
 * the starting values are a guess from the model's name. Each switch saves right away.
 */
export function CapabilityDialog({ model, onOpenChange }: { model: Model; onOpenChange: (open: boolean) => void }) {
  const update = useUpdateModel()
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`What ${model.display_name} can do`}
      description="Anemo only uses a feature the model is marked as having. Change these if the provider's model can do more, or less, than shown."
      footer={<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>}
    >
      <div className="mt-4 flex flex-col gap-3">
        {OPTIONS.map((option) => (
          <div key={option.key} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{option.label}</div>
              <div className="text-[12px] text-muted">{option.hint}</div>
            </div>
            <Switch
              label={`${option.label} for ${model.display_name}`}
              checked={Boolean(model.capabilities[option.key])}
              disabled={update.isPending}
              onChange={(on) => update.mutate({ id: model.id, body: { capabilities: { [option.key]: on } } })}
            />
          </div>
        ))}
      </div>
      {update.isError && <p className="mt-3 text-[13px] text-error">{errorMessage(update.error)}</p>}
    </Dialog>
  )
}
