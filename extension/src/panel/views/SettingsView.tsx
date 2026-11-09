import { useEffect, useState } from 'react'
import { LogOut, ShieldCheck } from 'lucide-react'
import type { Api } from '@/shared/api'
import type { Connection } from '@/shared/connection'
import { hasFeaturePermissions, releaseFeature, requestFeature, type FeatureKey } from '@/shared/permissions'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Notice } from '../ui/Notice'
import { Switch } from '../ui/Switch'
import { forgetToken } from '../state/connection'
import { FEATURES } from '../features'
import { NotificationsCard } from './NotificationsCard'
import { TranslateCard } from './TranslateCard'
import { usePreferences } from '../state/preferences'
import { SitesCard } from '../sites/SitesCard'

function ConnectionCard({ api, connection }: { api: Api; connection: Connection }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.DELETE('/api/auth/tokens/current')
      if (!res.response.ok && res.response.status !== 401) throw new Error(`HTTP ${res.response.status}`)
      await forgetToken()
    } catch {
      setError('Anemo couldn’t be reached to revoke the token. Forget it here anyway (and revoke it in Anemo later)?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader title="Connection" description={connection.serverUrl} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px]">
          <ShieldCheck className="h-4 w-4 text-success" />
          Signed in as <span className="font-medium">{connection.username}</span> with an API token
        </div>
        {error ? (
          <Notice tone="warning" title="Not disconnected yet" actions={<><Button size="sm" variant="danger" onClick={() => void forgetToken()}>Forget the token</Button><Button size="sm" variant="ghost" onClick={() => setError(null)}>Cancel</Button></>}>
            {error}
          </Notice>
        ) : (
          <div>
            <Button size="sm" icon={<LogOut className="h-3.5 w-3.5" />} loading={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
            <p className="mt-1.5 text-[12px] text-muted">Revokes this extension’s token in Anemo and returns to setup.</p>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function FeaturesCard() {
  const { prefs, update } = usePreferences()
  const [granted, setGranted] = useState<Partial<Record<FeatureKey, boolean>>>({})
  const [denied, setDenied] = useState<FeatureKey | null>(null)

  useEffect(() => {
    void Promise.all(FEATURES.map(async (f) => [f.key, await hasFeaturePermissions(f.key)] as const)).then((pairs) => setGranted(Object.fromEntries(pairs)))
  }, [prefs])

  const toggle = async (key: FeatureKey, on: boolean) => {
    setDenied(null)
    if (on) {
      // Straight from the click: Chrome only asks during a user action.
      const ok = await requestFeature(key)
      if (!ok) {
        setDenied(key)
        return
      }
    } else {
      await releaseFeature(key)
    }
    await update((p) => ({ ...p, features: { ...p.features, [key]: on } }))
  }

  return (
    <Card>
      <CardHeader title="Features" description="Optional parts ask for their permissions when you switch them on, and give them back when you switch them off." />
      <CardBody className="flex flex-col divide-y divide-border py-1">
        {FEATURES.map((f) => {
          const on = prefs.features[f.key] && (granted[f.key] ?? true)
          return (
            <div key={f.key} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">
                  {f.label}
                  {!f.available && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-normal text-muted">coming in a later step</span>}
                </div>
                <div className="text-[12px] text-muted">{f.description}</div>
                {f.asks && <div className="mt-0.5 text-[11.5px] text-subtle">Asks for: {f.asks}</div>}
                {denied === f.key && <div className="mt-1 text-[12px] text-error">Chrome’s permission wasn’t given, so it stays off.</div>}
              </div>
              <Switch label={f.label} checked={on} disabled={!f.available} onChange={(v) => void toggle(f.key, v)} />
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

export function SettingsView({ api, connection }: { api: Api; connection: Connection }) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <ConnectionCard api={api} connection={connection} />
      <FeaturesCard />
      <SitesCard />
      <TranslateCard />
      <NotificationsCard />
      <p className="px-1 text-[11.5px] text-subtle">
        Anemo Companion {chrome.runtime.getManifest().version} · extension id {chrome.runtime.id}
      </p>
    </div>
  )
}

