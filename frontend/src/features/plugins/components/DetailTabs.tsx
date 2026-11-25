/**
 * The tabs of a plugin's page in Settings > Plugins: Overview, Permissions, Contributions,
 * Versions, Source, Data and (when it has one) Settings; and the preview of a version that
 * isn't approved yet.
 */
import { Link } from 'react-router'
import { Eye, Paintbrush, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Markdown } from '@/components/ui/Markdown'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { formatSize, formatWhen } from '@/lib/format'
import { msg, t } from '@/lib/i18n'
import { actorLabel } from '@/features/provenance/labels'
import { usePluginData } from '../api'
import { PluginFrame } from '../host/PluginFrame'
import { applyPluginTheme } from '../themes'
import type { ManifestUi, PluginDetailOut, PluginVersionOut, VersionStatus } from '../types'
import { ContributionList, PermissionGroups, SourceInfo, VersionReview } from './Review'

const SECTION = 'text-[11px] font-semibold uppercase tracking-wider text-subtle'

/** The version whose permissions and contributions are shown: the approved one, else the newest. */
function shownVersion(plugin: PluginDetailOut): PluginVersionOut | null {
  return plugin.versions.find((v) => v.status === 'approved') ?? plugin.versions.find((v) => v.status === 'pending') ?? plugin.versions[0] ?? null
}

/** A short "Loading…" for the parts the list's data doesn't have yet. */
function Waiting() {
  return <p className="text-[13px] text-muted">{t('Loading…')}</p>
}

export function OverviewTab({ plugin, loading }: { plugin: PluginDetailOut; loading: boolean }) {
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      {plugin.readme ? (
        // The plugin's README, rendered like a document (no raw HTML; images from other sites wait for a click).
        <div className="text-[14px]"><Markdown text={plugin.readme} /></div>
      ) : (
        <p className="text-[14px]">{plugin.description}</p>
      )}
      {loading && <Waiting />}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 border-t border-border pt-(--card-y) text-[13px] sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted">{t('Plugin id')}</dt>
        <dd className="break-all font-mono text-[12px]">{plugin.id}</dd>
        {plugin.author && (<><dt className="text-muted">{t('Author')}</dt><dd>{plugin.author.name}{plugin.author.url && <span className="ml-1 break-all text-muted">({plugin.author.url})</span>}</dd></>)}
        {plugin.license && (<><dt className="text-muted">{t('License')}</dt><dd>{plugin.license}</dd></>)}
        <dt className="text-muted">{t('Updated')}</dt>
        <dd>{formatWhen(plugin.updated_at)}</dd>
      </dl>
    </div>
  )
}

export function PermissionsTab({ plugin, loading }: { plugin: PluginDetailOut; loading: boolean }) {
  const version = shownVersion(plugin)
  if (!version) return loading ? <Waiting /> : null
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      {version.status !== 'approved' && (
        <p className="text-[13px] text-warning">{t('Not granted yet: these are what version {version} asks for.', { version: version.version })}</p>
      )}
      <PermissionGroups permissions={version.permissions} />
    </div>
  )
}

export function ContributionsTab({ plugin, loading }: { plugin: PluginDetailOut; loading: boolean }) {
  const version = shownVersion(plugin)
  if (!version) return loading ? <Waiting /> : null
  const themes = version.manifest.contributes?.themes ?? []
  const approved = version.status === 'approved'
  return (
    <ContributionList contributions={version.contributions}
      action={(item) => {
        const theme = item.kind === 'themes' ? themes.find((x) => x.id === item.id) : undefined
        if (!theme) return null
        return (
          <Button size="sm" icon={<Paintbrush className="h-3.5 w-3.5" />} disabled={!approved}
            title={approved ? undefined : t('Approve the plugin first')}
            onClick={() => { applyPluginTheme(theme); toast({ message: t('Theme “{name}” applied. Change it back in Settings > Appearance.', { name: theme.name }) }) }}>
            {t('Apply')}
          </Button>
        )
      }} />
  )
}

const VERSION_STATUS: Record<VersionStatus, { label: string; tone: 'success' | 'warning' | 'neutral' | 'error' }> = {
  approved: { label: msg('Approved'), tone: 'success' },
  pending: { label: msg('Waiting for review'), tone: 'warning' },
  superseded: { label: msg('Earlier'), tone: 'neutral' },
  rejected: { label: msg('Rejected'), tone: 'error' },
}

export function VersionsTab({ plugin, loading, onPreview }: { plugin: PluginDetailOut; loading: boolean; onPreview: (version: string) => void }) {
  if (plugin.versions.length === 0) return loading ? <Waiting /> : null
  const pending = plugin.versions.find((v) => v.status === 'pending')
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      {pending && (
        <section aria-label={t('Waiting for review')} className="rounded-card border border-warning/40 px-(--card-x) py-(--card-y)">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold">{t('Version {version} is waiting for you', { version: pending.version })}</h3>
            {(pending.manifest.contributes?.ui?.length ?? 0) > 0 && (
              <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => onPreview(pending.version)}>{t('Preview')}</Button>
            )}
          </div>
          <VersionReview plugin={plugin} version={pending} />
        </section>
      )}
      <section aria-label={t('History')}>
        <h4 className={SECTION}>{t('History')}</h4>
        <ul className="mt-1 divide-y divide-border">
          {plugin.versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-(--item-y)">
              <span className="font-mono text-[13px] font-medium">{v.version}</span>
              <Badge tone={VERSION_STATUS[v.status].tone}>{t(VERSION_STATUS[v.status].label)}</Badge>
              <span className="min-w-0 flex-1 text-[12.5px] text-muted">
                {formatWhen(v.created_at)}
                {v.created_by && <> · {v.created_by.url ? <Link to={v.created_by.url} className="text-accent hover:underline">{actorLabel(v.created_by)}</Link> : actorLabel(v.created_by)}</>}
                {v.approved_at && <> · {t('approved {when}', { when: formatWhen(v.approved_at) })}</>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function SourceTab({ plugin }: { plugin: PluginDetailOut }) {
  return <SourceInfo plugin={plugin} chats={plugin.chats} />
}

export function DataTab({ plugin }: { plugin: PluginDetailOut }) {
  const data = usePluginData(plugin.id)
  if (data.isError) return <p className="text-[12.5px] text-error">{errorMessage(data.error)}</p>
  if (!data.data) return <Waiting />
  const items = data.data.items.filter((i) => i.count > 0)
  return (
    <div className="flex flex-col gap-(--stack-gap)">
      <p className="text-[13px] text-muted">{t('What this plugin created in Anemo and keeps for itself. You can see and change these like anything else.')}</p>
      {items.length === 0 && data.data.storage_bytes === 0 && <p className="text-[13px]">{t('Nothing yet.')}</p>}
      {items.length > 0 && (
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.kind} className="flex items-center justify-between gap-3 py-(--item-y) text-[13.5px]">
              <span>{i.label}</span>
              <span className="tabular-nums text-muted">{i.count}</span>
            </li>
          ))}
        </ul>
      )}
      {data.data.storage_bytes > 0 && (
        <p className="text-[13px]">{t('Its own storage: {size}', { size: formatSize(data.data.storage_bytes) })}</p>
      )}
    </div>
  )
}

/** The plugin's `settings` frame (contract §3), in a box of a fixed height. */
export function SettingsTab({ plugin, ui, version, active }: { plugin: PluginDetailOut; ui: ManifestUi; version: PluginVersionOut; active: boolean }) {
  if (!active) return <p className="text-[13px] text-muted">{t('Turn the plugin on to change its settings.')}</p>
  return (
    <div className="h-[min(70vh,640px)]">
      <PluginFrame key={`${version.version}/${ui.id}`} plugin={{ id: plugin.id, name: plugin.name, iconUrl: plugin.icon_url, version: version.version }}
        ui={ui.id} slot="settings" permissions={version.manifest.permissions} context={{}} active={active} fill
        title={t('Settings of {name}', { name: plugin.name })} />
    </div>
  )
}

/** The context a previewed UI gets: there is no real object or block to show it with. */
function previewContext(ui: ManifestUi): unknown {
  if (ui.slot === 'page') return { page: ui.id, params: {} }
  if (ui.slot === 'object.panel') return { object: { type: ui.objects?.[0] ?? 'document', id: null } }
  if (ui.slot === 'chat.block') return { block: { lang: ui.fence ?? '', text: '' } }
  return {}
}

const SLOT_NAMES: Record<ManifestUi['slot'], string> = {
  'object.panel': msg('Panel'),
  page: msg('Page'),
  settings: msg('Settings'),
  'chat.block': msg('Chat block'),
}

/**
 * Trying a version that isn't approved (contract §6.5): its frames, inside a banner that
 * says so. Read permissions work; every other call asks each time; nothing else of the
 * version (scripts, automations…) is created.
 */
export function PreviewPanel({ plugin, version, killed, onClose }: { plugin: PluginDetailOut; version: PluginVersionOut; killed: boolean; onClose: () => void }) {
  const uis = version.manifest.contributes?.ui ?? []
  const pages = uis.filter((u) => u.slot === 'page').map((u) => u.id)
  return (
    <section aria-label={t('Preview')} className="flex flex-col gap-(--stack-gap) rounded-card border-2 border-dashed border-accent/50 p-(--card-x)">
      <div className="flex flex-wrap items-center gap-2">
        <Eye className="h-4 w-4 text-accent" />
        <p className="min-w-0 flex-1 text-[13.5px] font-medium">{t('Preview of version {version}, not approved', { version: version.version })}</p>
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onClose}>{t('Close preview')}</Button>
      </div>
      <p className="text-[12.5px] text-muted">{t('It can read what it asks to read; anything else it tries asks you first, every time. Its scripts and automations are not created.')}</p>
      {killed && <p className="text-[12.5px] text-warning">{t('All plugins are turned off, so the preview can’t run.')}</p>}
      {uis.length === 0 && <p className="text-[13px]">{t('This version has no panels or pages to try.')}</p>}
      {uis.map((ui) => (
        <div key={ui.id} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <Badge>{t(SLOT_NAMES[ui.slot])}</Badge>
            <span>{ui.title ?? ui.id}</span>
          </div>
          <div className={cn(ui.slot === 'page' || ui.slot === 'settings' ? 'h-[min(60vh,560px)]' : undefined, 'rounded-control border border-border bg-surface p-2')}>
            <PluginFrame key={`${version.version}/${ui.id}`} preview active={!killed}
              plugin={{ id: plugin.id, name: plugin.name, iconUrl: plugin.icon_url, version: version.version }}
              ui={ui.id} slot={ui.slot} permissions={version.manifest.permissions} pages={pages}
              context={previewContext(ui)} height={ui.height} fill={ui.slot === 'page' || ui.slot === 'settings'} />
          </div>
        </div>
      ))}
    </section>
  )
}
