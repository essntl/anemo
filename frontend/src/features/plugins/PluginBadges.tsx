import { Badge } from '@/components/ui/Badge'
import { t } from '@/lib/i18n'
import type { PluginOut } from './types'

/**
 * A plugin's state as badges (contract §5, "Plugin states"): what needs the user, what
 * isn't working, and where it came from. On/off is the switch, not a badge.
 */
export function PluginBadges({ plugin, preview }: { plugin: PluginOut; preview?: string | null }) {
  return (
    <>
      {preview && <Badge tone="accent">{t('Preview')}</Badge>}
      {plugin.status === 'needs_review' && <Badge tone="warning">{t('Needs review')}</Badge>}
      {/* The server flags a first version waiting for review as pending too; that is no update. */}
      {plugin.update_pending && plugin.status !== 'needs_review' && <Badge tone="accent">{t('Update needs approval')}</Badge>}
      {plugin.status === 'error' && <Badge tone="error">{t('Error')}</Badge>}
      {plugin.made_by_assistant && <Badge>{t('Made by the assistant')}</Badge>}
    </>
  )
}
