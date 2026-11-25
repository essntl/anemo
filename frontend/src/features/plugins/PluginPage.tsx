/**
 * A plugin's page (contract §3 `page` slot) at /plugins/:pluginId/:uiId: Anemo's own header
 * with the plugin's icon and the page's title, and the plugin's frame filling the rest. The
 * query string is handed to the frame as `context.params`.
 */
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Puzzle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { t } from '@/lib/i18n'
import { usePluginContributions } from './api'
import { PluginFrame } from './host/PluginFrame'
import { NamedIcon, PluginIcon } from './PluginIcon'
import { framePlugin, pagesOf, usePluginUis } from './slotData'

export function PluginPage() {
  const { pluginId = '', uiId = '' } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const contributions = usePluginContributions()
  const all = usePluginUis()
  const ui = all.find((u) => u.plugin === pluginId && u.id === uiId && u.slot === 'page')

  if (!ui) {
    if (contributions.isPending) return <div aria-busy className="m-4 h-64 animate-pulse rounded-card bg-surface-2 motion-reduce:animate-none md:mx-8" />
    return (
      <EmptyState icon={<Puzzle className="h-5 w-5" />} title={t('This plugin page isn’t available')}
        description={contributions.data?.disabled_all
          ? t('All plugins are turned off in Settings > Plugins.')
          : t('Its plugin may be turned off, waiting for review, or uninstalled.')}
        action={<Button onClick={() => void navigate('/settings/plugins')}>{t('Open Settings > Plugins')}</Button>} />
    )
  }

  const title = ui.title ?? ui.plugin_name
  return (
    <div className="flex h-full min-h-0 flex-col p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={title}
        before={<NamedIcon name={ui.icon} className="h-5 w-5 shrink-0 text-accent" fallback={<PluginIcon url={ui.icon_url} size={24} className="rounded-md" />} />}
        detail={title !== ui.plugin_name ? ui.plugin_name : undefined} />
      <div className="min-h-[24rem] flex-1">
        <PluginFrame key={`${ui.plugin}@${ui.version}/${ui.id}`} plugin={framePlugin(ui)} ui={ui.id} slot="page"
          permissions={ui.permissions} pages={pagesOf(all, ui.plugin)} active fill title={title}
          context={{ page: ui.id, params: Object.fromEntries(search.entries()) }} />
      </div>
    </div>
  )
}
