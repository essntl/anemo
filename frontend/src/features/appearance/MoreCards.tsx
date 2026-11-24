/** Settings > Appearance: the preview, frosted glass, and this device (own appearance, export, import). */
import { useRef } from 'react'
import { Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { Avatar } from '@/features/profile/Avatar'
import { useSettings } from '@/features/settings/api'
import { currentAppearance, useThemeStore } from '@/features/settings/theme'
import { t } from '@/lib/i18n'
import { useAppearanceAssets } from './api'
import { exportJson, parseImport } from './transfer'

/** A small sample of the app in the current look: it changes as you change things. */
export function PreviewCard() {
  return (
    <Card aria-label={t('Preview')}>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start justify-end gap-2">
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14.5px]">
            {t('Can you sum up this week for me?')}
          </div>
          <Avatar size={28} />
        </div>
        <p className="text-[14.5px] leading-7">
          {t('Sure. Three tasks are done and two are due tomorrow.')}{' '}
          <span className="text-accent underline underline-offset-2">{t('Open the tasks')}</span>
        </p>
        <p className="text-[13px] text-muted">{t('Secondary text looks like this.')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary">{t('Primary button')}</Button>
          <Button size="sm">{t('Button')}</Button>
          <code className="self-center rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px]">npm run build</code>
        </div>
      </CardBody>
    </Card>
  )
}

export function GlassCard() {
  const glass = useThemeStore((s) => s.glass)
  const set = useThemeStore((s) => s.set)
  return (
    <Card>
      <CardHeader title={t('Frosted glass')}
        description={t('The sidebar, cards, dialogs and the message box let the background show through, blurred. Off when your system asks for less transparency.')}
        actions={<Switch label={t('Frosted glass')} checked={glass} onChange={(v) => set({ glass: v })} />} />
    </Card>
  )
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function DeviceCard() {
  const deviceOnly = useThemeStore((s) => s.deviceOnly)
  const settings = useSettings()
  const assets = useAppearanceAssets()
  const input = useRef<HTMLInputElement>(null)

  const toggle = (on: boolean) => {
    const store = useThemeStore.getState()
    store.setDeviceOnly(on)
    // Back to the shared appearance: show it again.
    if (!on && settings.data) store.hydrate(settings.data.appearance)
  }

  const onImport = async (file: File | undefined) => {
    if (!file) return
    try {
      const look = parseImport(await file.text(), (assets.data ?? []).map((a) => a.id))
      // set (not hydrate): an import is an edit, so it is saved like one.
      useThemeStore.getState().set(look)
      toast({ message: t('Appearance imported.') })
    } catch {
      toast({ message: t("This file isn't an Anemo appearance file.") })
    }
  }

  return (
    <Card>
      <CardHeader title={t('This device')} description={t('Your appearance is saved on the server and follows you to every device.')} />
      <CardBody className="flex flex-col gap-4">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-[13.5px] font-medium">{t('Use a different appearance on this device')}</span>
            <span className="block text-[12.5px] text-muted">{t('Changes made here then stay in this browser and are not saved to the server.')}</span>
          </span>
          <Switch label={t('Use a different appearance on this device')} checked={deviceOnly} onChange={toggle} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}
            onClick={() => download('anemo-appearance.json', exportJson(currentAppearance()))}>
            {t('Export')}
          </Button>
          <input ref={input} type="file" accept="application/json,.json" className="hidden" aria-hidden tabIndex={-1}
            onChange={(e) => { void onImport(e.target.files?.[0]); e.target.value = '' }} />
          <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => input.current?.click()}>
            {t('Import')}
          </Button>
          <span className="text-[12px] text-muted">{t('A small JSON file. Uploaded fonts and pictures stay on the server; they are only referred to.')}</span>
        </div>
      </CardBody>
    </Card>
  )
}
