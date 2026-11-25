/**
 * Settings > Plugins: the kill switch, the installed plugins as a grid of cards, and the
 * way to install more.
 *
 * Why in Settings (and marked with the shield) rather than a page of its own in the
 * sidebar: installing and approving a plugin is configuration with the weight of adding an
 * MCP server (the password is asked again, it lands in the security log), and the sidebar
 * is for daily work. A plugin's own *pages* do appear in the sidebar, in their own group
 * (spec 12-plugins.md §3).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, Puzzle } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Lingering } from '@/components/ui/Lingering'
import { SettingRow } from '@/components/ui/SettingRow'
import { t } from '@/lib/i18n'
import { usePlugins, useInstallPlugin, useSetPluginsKillSwitch } from './api'
import { BundledList, InstallDialog } from './components/InstallDialog'
import { PluginCard } from './components/PluginCard'
import { beginPluginTransition, RUNNING_CLASS, RUNNING_MS, transitionMode, useHeroStore } from './transition'
import type { PluginDetailOut } from './types'

type Installing = { installed?: PluginDetailOut }

export function PluginsSettingsPage() {
  const navigate = useNavigate()
  const plugins = usePlugins()
  const killSwitch = useSetPluginsKillSwitch()
  const install = useInstallPlugin()
  const hero = useHeroStore((s) => s.id)
  const [installing, setInstalling] = useState<Installing | null>(null)
  const mode = transitionMode()
  const items = plugins.data?.plugins ?? []
  const off = plugins.data?.disabled_all ?? false

  // Coming back from a plugin's page: its card is where the page shrinks back to, so the
  // page's own cross-fade steps aside (as on the way there). Runs while the browser holds
  // the old picture, before the transition's animations start.
  const comingBack = useRef(hero !== null && mode === 'view-transition')
  useLayoutEffect(() => {
    if (!comingBack.current) return
    const root = document.documentElement
    root.classList.add(RUNNING_CLASS)
    const timer = window.setTimeout(() => root.classList.remove(RUNNING_CLASS), RUNNING_MS)
    return () => window.clearTimeout(timer)
  }, [])

  // The plugin page's code, loaded ahead: the router waits for it before the transition
  // starts, so a first click would otherwise pause.
  useEffect(() => {
    void import('./PluginDetailPage')
  }, [])

  const open = (id: string) => {
    void navigate(`/settings/plugins/${encodeURIComponent(id)}`, { ...beginPluginTransition(id), state: { fromList: true } })
  }

  return (
    <div className="flex flex-col gap-(--card-gap)">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Puzzle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t('Plugins')}</h2>
          <p className="text-[13px] text-muted">
            {t('Plugins add panels, pages, commands and more to Anemo. Each one runs in a closed box and can only do what you approved.')}
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setInstalling({})}>{t('Install')}</Button>
      </div>

      <Card>
        <SettingRow heading title={t('Turn off all plugins')}
          description={off
            ? t('Every plugin is stopped. Turn this off to bring back the ones that were on.')
            : t('Stops every plugin at once: no panels, pages, commands, scripts or plugin tools. Each plugin keeps its own switch.')}
          checked={off} onCheckedChange={(next) => killSwitch.mutate(next)} />
        {killSwitch.isError && <p className="px-(--card-x) pb-(--card-y) text-[12.5px] text-error">{errorMessage(killSwitch.error)}</p>}
      </Card>

      {plugins.isError && <p className="text-[13px] text-error">{errorMessage(plugins.error)}</p>}
      {plugins.isPending && (
        <div aria-hidden className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-(--card-gap)">
          {[0, 1].map((i) => <div key={i} className="h-[9.5rem] animate-pulse rounded-card bg-surface-2 motion-reduce:animate-none" />)}
        </div>
      )}
      {plugins.isSuccess && items.length === 0 && (
        <Card>
          <EmptyState icon={<Puzzle className="h-5 w-5" />} title={t('No plugins yet')}
            description={t('Install one from a zip file or a Git address, or start with an example below. You can also ask the assistant to build one for you.')}>
            <div className="mt-5 w-full max-w-md">
              <BundledList busyId={install.isPending && install.variables?.kind === 'bundled' ? install.variables.id : null}
                onInstall={(id) => install.mutate({ kind: 'bundled', id }, { onSuccess: (installed) => setInstalling({ installed }) })} />
              {install.isError && <p role="alert" className="mt-2 text-[12.5px] text-error">{errorMessage(install.error)}</p>}
            </div>
          </EmptyState>
        </Card>
      )}
      {items.length > 0 && (
        <ul aria-label={t('Installed plugins')} className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-(--card-gap)">
          {items.map((plugin) => (
            <li key={plugin.id} className="flex min-w-0">
              <div className="flex min-w-0 flex-1 flex-col [&>article]:flex-1">
                <PluginCard plugin={plugin} hero={plugin.id === hero} mode={mode} onOpen={() => open(plugin.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Lingering value={installing}>
        {(shown) => <InstallDialog start={shown.installed ? { installed: shown.installed } : undefined}
          onClose={() => setInstalling(null)} onOpen={(id) => { setInstalling(null); open(id) }} />}
      </Lingering>
    </div>
  )
}
