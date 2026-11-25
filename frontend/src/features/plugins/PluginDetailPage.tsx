/**
 * A plugin's page in Settings > Plugins (/settings/plugins/:pluginId): its header (icon,
 * name, author, version, state, switch and actions) and tabs. `?preview=<version>` shows
 * the preview of a version that isn't approved; `?tab=` remembers the tab.
 *
 * It is the far end of the card → page transition (transition.ts): the whole sheet, the
 * icon and the name carry the shared names, so the clicked card grows into it. On a phone
 * the sheet covers the screen. It draws at once from the list's data (api.ts seeds the
 * query), so the transition never shows a loading state; the rest fills in when it arrives.
 */
import { motion } from 'motion/react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useState } from 'react'
import { Bot, ChevronLeft, Eye, ShieldAlert, Trash2, TriangleAlert, XCircle } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu, type MenuAction } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Lingering } from '@/components/ui/Lingering'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { chatLink } from '@/lib/appLinks'
import { cn } from '@/lib/cn'
import { msg, plural, t } from '@/lib/i18n'
import { usePlugin, usePlugins, useRejectVersion, useSetPluginEnabled, useStartPluginChat } from './api'
import { ContributionsTab, DataTab, OverviewTab, PermissionsTab, PreviewPanel, SettingsTab, SourceTab, VersionsTab } from './components/DetailTabs'
import { UninstallDialog } from './components/UninstallDialog'
import { usePluginIncidents } from './host/incidents'
import { PluginBadges } from './PluginBadges'
import { PluginIcon } from './PluginIcon'
import { beginPluginTransition, HERO, HERO_ICON, HERO_NAME, heroLayoutId, heroStyle, transitionMode } from './transition'

const TABS = [
  { id: 'overview', label: msg('Overview') },
  { id: 'permissions', label: msg('Permissions') },
  { id: 'contributions', label: msg('Contributions') },
  { id: 'versions', label: msg('Versions') },
  { id: 'source', label: msg('Source') },
  { id: 'data', label: msg('Data') },
  { id: 'settings', label: msg('Settings') },
] as const
type Tab = (typeof TABS)[number]['id']

export function PluginDetailPage() {
  const id = useParams().pluginId ?? ''
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const desktop = useMediaQuery(DESKTOP)
  const mode = transitionMode()
  const query = usePlugin(id)
  const list = usePlugins()
  const setEnabled = useSetPluginEnabled()
  const reject = useRejectVersion()
  const startChat = useStartPluginChat()
  const incidents = usePluginIncidents(id)
  const [uninstalling, setUninstalling] = useState(false)

  const plugin = query.data
  // Seeded from the card: the header is right, the detail-only parts are still on their way.
  const loading = query.isPlaceholderData || query.isPending
  const killed = list.data?.disabled_all ?? false
  const approved = plugin?.versions.find((v) => v.status === 'approved') ?? null
  const pending = plugin?.versions.find((v) => v.status === 'pending') ?? null
  const settingsUi = approved?.manifest.contributes?.ui?.find((u) => u.slot === 'settings') ?? null
  const tabs = TABS.filter((tab) => tab.id !== 'settings' || settingsUi)
  const tabParam = params.get('tab')
  const tab: Tab = tabs.some((x) => x.id === tabParam) ? (tabParam as Tab) : 'overview'
  const previewParam = params.get('preview')
  const previewVersion = previewParam ? plugin?.versions.find((v) => v.version === previewParam) ?? null : null

  const setTab = (next: Tab) => setParams((p) => { p.set('tab', next); p.delete('preview'); return p }, { replace: true })
  const setPreview = (version: string | null) =>
    setParams((p) => { if (version) p.set('preview', version); else p.delete('preview'); return p }, { replace: true })

  // Back to the list: the page shrinks into its card. Through history when we came from
  // the list (so Back and this button do the same), else as a new step.
  const back = () => {
    const options = beginPluginTransition(id)
    if ((location.state as { fromList?: boolean } | null)?.fromList) void navigate(-1)
    else void navigate('/settings/plugins', options)
  }

  if (!plugin) {
    if (query.isError) {
      return (
        <EmptyState icon={<XCircle className="h-5 w-5" />} title={t('This plugin isn’t installed')}
          description={errorMessage(query.error)}
          action={<Button onClick={() => void navigate('/settings/plugins')}>{t('All plugins')}</Button>} />
      )
    }
    return <div aria-busy className="h-64 animate-pulse rounded-card bg-surface-2 motion-reduce:animate-none" />
  }

  const confirmReject = async () => {
    if (!pending) return
    const ok = await confirmDialog({
      title: t('Reject version {version}?', { version: pending.version }),
      message: plugin.approved_version ? t('Version {version} keeps running.', { version: plugin.approved_version }) : t('Nothing of it was ever approved, so nothing changes.'),
      confirmLabel: t('Reject'),
      danger: true,
    })
    if (ok) reject.mutate({ id: plugin.id, version: pending.version })
  }

  const menu: MenuAction[] = [
    {
      label: t('Continue building with the assistant'),
      icon: <Bot />,
      onSelect: () => startChat.mutate(plugin.id, {
        onSuccess: (chat) => void navigate(chatLink(chat.conversation_id)),
        onError: (err) => toast({ message: errorMessage(err) }),
      }),
    },
    ...(pending ? [{ label: t('Reject version {version}', { version: pending.version }), icon: <XCircle />, onSelect: () => void confirmReject() }] : []),
    { label: t('Uninstall'), icon: <Trash2 />, danger: true, onSelect: () => setUninstalling(true) },
  ]

  const header = (
    <header className="flex flex-col gap-(--stack-gap)">
      <button type="button" onClick={back}
        className="-ml-1.5 flex h-8 w-fit items-center gap-0.5 rounded-control pr-2 text-[13px] font-medium text-muted hover:text-text pointer-coarse:h-10">
        <ChevronLeft className="h-4 w-4" />{t('All plugins')}
      </button>
      <div className="flex items-start gap-3.5">
        <motion.div layoutId={heroLayoutId(plugin.id, 'icon', mode)} style={heroStyle(true, HERO_ICON, mode)} className="shrink-0">
          <PluginIcon url={plugin.icon_url} size={56} />
        </motion.div>
        <div className="min-w-0 flex-1">
          <motion.h2 layoutId={heroLayoutId(plugin.id, 'name', mode)} style={heroStyle(true, HERO_NAME, mode)}
            className="w-fit max-w-full break-words text-[19px] font-bold tracking-tight">
            {plugin.name}
          </motion.h2>
          <p className="text-[13px] text-muted">
            {plugin.author?.name && <>{plugin.author.name} · </>}
            <span className="tabular-nums">{t('Version {version}', { version: plugin.version })}</span>
          </p>
          <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-1.5">
            <PluginBadges plugin={plugin} preview={previewVersion?.version} />
          </div>
        </div>
        <div className="pt-1">
          <Switch label={t('Use {name}', { name: plugin.name })} checked={plugin.enabled}
            disabled={plugin.status === 'needs_review' || setEnabled.isPending}
            onChange={(enabled) => setEnabled.mutate({ id: plugin.id, enabled })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pending && (
          <Button variant="primary" size="sm" icon={<ShieldAlert className="h-3.5 w-3.5" />} onClick={() => setTab('versions')}>
            {plugin.approved_version ? t('Review update') : t('Review and approve')}
          </Button>
        )}
        {pending && (pending.manifest.contributes?.ui?.length ?? 0) > 0 && (
          <Button size="sm" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setPreview(pending.version)}>{t('Preview')}</Button>
        )}
        <ActionMenu actions={menu} className="ml-auto" />
      </div>
      {plugin.status === 'error' && plugin.error && (
        <p role="alert" className="flex items-start gap-2 rounded-control bg-error/12 px-3 py-2 text-[12.5px] text-error">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{t('Stopped: {problem}', { problem: plugin.error })}</span>
        </p>
      )}
      {incidents.length > 0 && (
        <p role="alert" className="flex items-start gap-2 rounded-control bg-warning/12 px-3 py-2 text-[12.5px] text-warning">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{plural(incidents.length,
            'One of its frames tried to open another address, so Anemo closed it. That can be a way to send data out: check its code before you trust it.',
            '{n} of its frames tried to open another address, so Anemo closed them. That can be a way to send data out: check its code before you trust it.')}</span>
        </p>
      )}
      {killed && <p className="text-[12.5px] text-warning">{t('All plugins are turned off right now (the switch at the top of Settings > Plugins).')}</p>}
      {(setEnabled.error ?? reject.error) && <p className="text-[12.5px] text-error">{errorMessage(setEnabled.error ?? reject.error)}</p>}
    </header>
  )

  const content = previewParam ? (
    previewVersion ? <PreviewPanel plugin={plugin} version={previewVersion} killed={killed} onClose={() => setPreview(null)} />
      : loading ? <p className="text-[13px] text-muted">{t('Loading…')}</p>
      : <p className="text-[13px] text-muted">{t('There is no version {version} to preview.', { version: previewParam })}</p>
  ) : (
    <>
      <div className="no-scrollbar -mx-(--card-x) overflow-x-auto px-(--card-x)">
        <Segmented kind="tabs" label={t('About this plugin')} controls="plugin-tab" value={tab} onChange={setTab} className="max-w-none"
          options={tabs.map((x) => ({ value: x.id, label: t(x.label) }))} />
      </div>
      <div id={`plugin-tab-${tab}`} role="tabpanel" className="min-h-40">
        {tab === 'overview' && <OverviewTab plugin={plugin} loading={loading} />}
        {tab === 'permissions' && <PermissionsTab plugin={plugin} loading={loading} />}
        {tab === 'contributions' && <ContributionsTab plugin={plugin} loading={loading} />}
        {tab === 'versions' && <VersionsTab plugin={plugin} loading={loading} onPreview={setPreview} />}
        {tab === 'source' && <SourceTab plugin={plugin} />}
        {tab === 'data' && <DataTab plugin={plugin} />}
        {tab === 'settings' && settingsUi && approved && <SettingsTab plugin={plugin} ui={settingsUi} version={approved} active={plugin.enabled && !killed} />}
      </div>
    </>
  )

  return (
    <>
      <motion.section
        layoutId={heroLayoutId(plugin.id, 'card', mode)}
        style={heroStyle(true, HERO, mode)}
        aria-label={plugin.name}
        className={cn(
          'flex flex-col gap-(--card-gap) bg-card px-(--card-x) py-(--card-y)',
          desktop
            ? 'glass rounded-card border border-border shadow-soft'
            // A phone: a sheet over the whole screen, grown from the card.
            : 'fixed inset-0 z-30 overflow-y-auto overscroll-contain rounded-none pt-[max(var(--card-y),env(safe-area-inset-top))] pb-[max(var(--card-y),env(safe-area-inset-bottom))]',
        )}
      >
        {header}
        {content}
      </motion.section>
      <Lingering value={uninstalling && plugin}>
        {(shown) => (
          <UninstallDialog plugin={shown} onClose={() => setUninstalling(false)}
            onDone={() => { setUninstalling(false); toast({ message: t('“{name}” was uninstalled.', { name: shown.name }) }); void navigate('/settings/plugins', { replace: true }) }} />
        )}
      </Lingering>
    </>
  )
}
