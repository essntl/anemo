import { m } from 'motion/react'
import { useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { prefetchPlugin, useSetPluginEnabled } from '../api'
import { PluginBadges } from '../PluginBadges'
import { PluginIcon } from '../PluginIcon'
import { HERO, HERO_ICON, HERO_NAME, heroLayoutId, heroStyle, type TransitionMode } from '../transition'
import type { PluginOut } from '../types'

/**
 * One plugin in the grid of Settings > Plugins: its icon, name, a short description, the
 * version, its badges and its switch. The whole card opens the plugin's page (a button laid
 * over it); the switch sits above that button, so flipping it doesn't open anything.
 *
 * `hero`: this is the card that grows into the page (or that the page shrinks back into),
 * so it carries the shared names of the transition (transition.ts).
 */
export function PluginCard({ plugin, hero, mode, onOpen }: { plugin: PluginOut; hero: boolean; mode: TransitionMode; onOpen: () => void }) {
  const qc = useQueryClient()
  const setEnabled = useSetPluginEnabled()
  const canSwitch = plugin.status !== 'needs_review'
  // Its data is fetched as soon as the pointer or the focus is on it, so the page usually
  // has the whole detail by the time the transition ends.
  const warm = () => prefetchPlugin(qc, plugin.id)

  return (
    <m.article
      layoutId={heroLayoutId(plugin.id, 'card', mode)}
      style={heroStyle(hero, HERO, mode)}
      aria-labelledby={`plugin-${plugin.id}-name`}
      className={cn(
        'glass group relative flex min-w-0 flex-col gap-2.5 rounded-card border border-border bg-card px-(--card-x) py-(--card-y) shadow-soft',
        'transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-float motion-reduce:transition-none',
        // Keeps a change inside one card from making the browser lay out the whole grid.
        '[contain:layout]',
      )}
    >
      {/* The card's click target: under the switch, over everything else. */}
      <button type="button" aria-label={t('Open {name}', { name: plugin.name })}
        onClick={onOpen} onPointerEnter={warm} onFocus={warm}
        className="absolute inset-0 z-0 rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />

      <div className="pointer-events-none flex items-start gap-3">
        <m.div layoutId={heroLayoutId(plugin.id, 'icon', mode)} style={heroStyle(hero, HERO_ICON, mode)} className="shrink-0">
          <PluginIcon url={plugin.icon_url} size={40} />
        </m.div>
        <div className="min-w-0 flex-1">
          <m.h3 layoutId={heroLayoutId(plugin.id, 'name', mode)} id={`plugin-${plugin.id}-name`}
            style={heroStyle(hero, HERO_NAME, mode)} className="w-fit max-w-full truncate text-[15px] font-semibold">
            {plugin.name}
          </m.h3>
          <p className="text-[12px] tabular-nums text-subtle">{plugin.version}</p>
        </div>
        <div className="pointer-events-auto relative z-10 pt-1" onClick={(e) => e.stopPropagation()}>
          <Switch label={t('Use {name}', { name: plugin.name })} checked={plugin.enabled} disabled={!canSwitch || setEnabled.isPending}
            onChange={(enabled) => setEnabled.mutate({ id: plugin.id, enabled })} />
        </div>
      </div>
      {/* Two lines at most, and always room for two, so the cards of a row line up. */}
      <p className="pointer-events-none line-clamp-2 min-h-[2lh] text-[13px] text-muted">{plugin.description}</p>
      <div className="pointer-events-none flex min-h-5 flex-wrap items-center gap-1.5">
        <PluginBadges plugin={plugin} />
        {plugin.status === 'error' && plugin.error && <span className="sr-only">{plugin.error}</span>}
      </div>
    </m.article>
  )
}
