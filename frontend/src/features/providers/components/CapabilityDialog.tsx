import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Switch } from '@/components/ui/Switch'
import { type Model, useUpdateModel } from '../api'
import { msg, t } from '@/lib/i18n'

/** What each switch means, in the order shown. Embedding models are a different kind
 *  of model, so that is not a switch here. */
const OPTIONS: { key: string; label: string; hint: string }[] = [
  { key: 'tools', label: msg('Tools'), hint: msg('Needed for Agent mode and for remembering things in chats.') },
  { key: 'vision', label: msg('Vision'), hint: msg('Can look at images you attach.') },
  { key: 'pdf', label: 'PDF', hint: msg('Reads PDF files directly. When off, their text is extracted first.') },
  { key: 'reasoning', label: msg('Reasoning'), hint: msg('Thinks before answering, where the provider supports it.') },
  { key: 'structured_output', label: msg('JSON output'), hint: msg('Can be made to answer in a fixed JSON shape.') },
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
      title={t('What {name} can do', { name: model.display_name })}
      description={t("Anemo only uses a feature the model is marked as having. Change these if the provider's model can do more, or less, than shown.")}
      footer={<Button variant="primary" onClick={() => onOpenChange(false)}>{t('Done')}</Button>}
    >
      <div className="mt-4 flex flex-col gap-3">
        {OPTIONS.map((option) => (
          <div key={option.key} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t(option.label)}</div>
              <div className="text-[12px] text-muted">{t(option.hint)}</div>
            </div>
            <Switch
              label={t('{capability} for {name}', { capability: t(option.label), name: model.display_name })}
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
