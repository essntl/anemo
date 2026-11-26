/** Settings > Appearance > Fonts: the UI font and the code font, and uploaded font files. */
import { useRef } from 'react'
import { Trash2, Upload } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Input'
import { Select, type SelectOption } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { useThemeStore } from '@/features/settings/theme'
import { formatSize } from '@/lib/format'
import { t } from '@/lib/i18n'
import { type AppearanceAsset, useAppearanceAssets, useDeleteAsset, useUploadAsset } from './api'
import { CODE_FONTS, customFontChoice, customFontId, type FontChoice, fontStack, UI_FONTS } from './fonts'

/** What the file picker offers; the server checks the content anyway. */
export const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf'

const GROUP_LABEL: Record<FontChoice['group'], () => string> = {
  default: () => '',
  bundled: () => t('comes with Anemo'),
  system: () => t('from your system'),
}

function options(list: FontChoice[], uploaded: AppearanceAsset[]): SelectOption[] {
  return [
    ...list.map((f) => ({
      value: f.id,
      label: (
        <span>
          {t(f.label)}
          {f.group !== 'default' && <span className="ml-1.5 text-[12px] text-subtle">· {GROUP_LABEL[f.group]()}</span>}
        </span>
      ),
    })),
    ...uploaded.map((a) => ({
      value: customFontChoice(a.id),
      label: <span>{a.filename}<span className="ml-1.5 text-[12px] text-subtle">· {t('uploaded')}</span></span>,
    })),
  ]
}

export function FontCard() {
  const uiFont = useThemeStore((s) => s.ui_font)
  const codeFont = useThemeStore((s) => s.code_font)
  const set = useThemeStore((s) => s.set)
  const assets = useAppearanceAssets()
  const fonts = (assets.data ?? []).filter((a) => a.kind === 'font')
  const upload = useUploadAsset()
  const remove = useDeleteAsset()
  const input = useRef<HTMLInputElement>(null)

  const onFile = (file: File | undefined) => {
    if (!file) return
    upload.mutate({ file, kind: 'font' }, {
      onSuccess: (asset) => {
        set({ ui_font: customFontChoice(asset.id) })
        toast({ message: t('Font uploaded. It is now the interface font; you can choose it for code too.') })
      },
      onError: (err) => toast({ message: t("Couldn't use this font: {error}", { error: errorMessage(err) }) }),
    })
  }

  // An uploaded font that is no longer in the list (deleted on another device) shows as the default.
  const known = (choice: string) => !customFontId(choice) || fonts.some((f) => f.id === customFontId(choice))
  return (
    <Card>
      <CardHeader title={t('Fonts')} description={t('Fonts that come with Anemo are part of the app: nothing is loaded from Google Fonts or any other site.')} />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('Interface')}>
            <Select aria-label={t('Interface font')} value={known(uiFont) ? uiFont : 'default'}
              onValueChange={(v) => set({ ui_font: v })} options={options(UI_FONTS, fonts)} />
          </Field>
          <Field label={t('Code')}>
            <Select aria-label={t('Code font')} value={known(codeFont) ? codeFont : 'default'}
              onValueChange={(v) => set({ code_font: v })} options={options(CODE_FONTS, fonts)} />
          </Field>
        </div>
        <p className="rounded-control bg-surface-2 px-3 py-2 text-[14px]" style={{ fontFamily: fontStack(uiFont, 'ui') ?? undefined }}>
          {t('The quick brown fox jumps over the lazy dog.')}{' '}
          <code className="font-mono text-[13px]">const answer = 42</code>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept={FONT_ACCEPT} className="hidden" aria-hidden tabIndex={-1}
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
          <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>
            {t('Upload a font')}
          </Button>
          <span className="text-[12px] text-muted">{t('WOFF2, WOFF, TTF or OTF, up to 4 MB.')}</span>
        </div>
        {fonts.length > 0 && (
          <ul className="flex flex-col divide-y divide-border rounded-control border border-border">
            {fonts.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                <span className="text-[12px] text-subtle">{formatSize(f.size)}</span>
                <Button size="icon" variant="ghost" aria-label={t('Delete {name}', { name: f.filename })}
                  onClick={() => remove.mutate(f.id, { onError: (err) => toast({ message: errorMessage(err) }) })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
