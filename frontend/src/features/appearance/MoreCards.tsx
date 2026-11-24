/** Settings > Appearance: the preview, frosted glass, and this device (own appearance, export, import). */
import { useRef } from 'react'
import { Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SettingRow } from '@/components/ui/SettingRow'
import { SliderField } from '@/components/ui/Slider'
import { toast } from '@/components/ui/toast'
import { useSettings } from '@/features/settings/api'
import { currentAppearance, resolveMode, useThemeStore } from '@/features/settings/theme'
import { t } from '@/lib/i18n'
import { useAppearanceAssets } from './api'
import { glassLook } from './apply'
import { swatchBackground } from './gradients'
import { exportJson, parseImport } from './transfer'

/** A small sample of the app in the current look: it changes as you change things. */
export function PreviewCard() {
  return (
    <Card aria-label={t('Preview')}>
      <CardBody className="flex flex-col gap-3">
        {/* As in a chat: your message on the right, without an avatar. */}
        <div className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14.5px]">
          {t('Can you sum up this week for me?')}
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
  const strength = useThemeStore((s) => s.glass_strength)
  const accent = useThemeStore((s) => s.accent)
  const set = useThemeStore((s) => s.set)
  const mode = resolveMode(useThemeStore((s) => s.mode))
  const look = glassLook(strength, mode)
  return (
    <Card>
      <SettingRow heading title={t('Frosted glass')}
        description={t('The sidebar, cards, dialogs and the message box let the background show through, blurred. Off when your system asks for less transparency.')}
        checked={glass} onCheckedChange={(v) => set({ glass: v })}>
        <div className="flex flex-col gap-4">
          <SliderField label={t('Strength')} min={0} max={100} step={5} value={strength}
            format={(v) => `${v} %`} onChange={(v) => set({ glass_strength: Math.round(v) })} />
          {/* A pane of glass at this strength over colour stripes: the same as the app's panels. */}
          <div aria-hidden data-testid="glass-preview" className="relative h-24 overflow-hidden rounded-control"
            style={{ background: swatchBackground([accent, 'var(--chart-2)', 'var(--chart-3)', accent], 120) }}>
            <div className="glass-preview absolute inset-x-6 inset-y-4 flex items-center justify-center rounded-control border border-border text-[13px] font-medium shadow-soft"
              style={{
                backgroundColor: `color-mix(in srgb, var(--surface) ${look.opacity}%, transparent)`,
                backdropFilter: `blur(${look.blur}px) saturate(1.3)`,
              }}>
              {t('Text on glass stays readable')}
            </div>
          </div>
        </div>
      </SettingRow>
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
      <CardBody className="flex flex-col gap-(--card-y)">
        <SettingRow className="p-0" title={t('Use a different appearance on this device')}
          description={t('Changes made here then stay in this browser and are not saved to the server.')}
          checked={deviceOnly} onCheckedChange={toggle} />
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
          <span className="max-w-prose text-[12px] text-muted">{t('A small JSON file. Uploaded fonts and pictures stay on the server; they are only referred to.')}</span>
        </div>
      </CardBody>
    </Card>
  )
}
