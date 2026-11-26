import { Badge } from '@/components/ui/Badge'
import { confirmDialog } from '@/components/ui/dialogs'
import { t } from '@/lib/i18n'
import { PluginIcon } from '../PluginIcon'
import { RISK_LABELS } from '../permissions'
import type { ConfirmRequest } from './channel'

export interface PluginIdentity {
  id: string
  name: string
  iconUrl: string | null
}

/**
 * Anemo's own dialog for a plugin call that needs the user's OK (contract §6.4, rule 3):
 * which plugin, what it wants to do (the server's summary), how risky that is, Allow or
 * Deny. It is drawn by Anemo's page, never inside the frame, so a plugin can't fake or
 * click it. The focus starts on Deny, so a stray Enter allows nothing.
 */
export function confirmPluginCall(plugin: PluginIdentity, request: ConfirmRequest): Promise<boolean> {
  const tone = request.risk === 'critical' ? 'error' : request.risk === 'high' ? 'warning' : 'neutral'
  return confirmDialog({
    title: t('Allow {name} to do this?', { name: plugin.name }),
    message: (
      <div className="flex items-start gap-3">
        <PluginIcon url={plugin.iconUrl} size={36} />
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13.5px] text-text">{request.summary}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={tone}>{t(RISK_LABELS[request.risk])}</Badge>
            <span className="text-[12px] text-muted">{t('Asked by the plugin {name}', { name: plugin.name })}</span>
          </div>
        </div>
      </div>
    ),
    confirmLabel: t('Allow'),
    cancelLabel: t('Deny'),
    focusCancel: true,
    danger: request.risk === 'critical',
  })
}
