/**
 * Settings > Appearance > Background: none, an animated gradient (a preset or your own)
 * or an upload; then its effects: blur, dim, fit, and whether it moves on phones.
 */
import { useRef } from 'react'
import { Film, Trash2, Upload } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Segmented } from '@/components/ui/Segmented'
import { FieldRow, SettingRow } from '@/components/ui/SettingRow'
import { SliderField } from '@/components/ui/Slider'
import { toast } from '@/components/ui/toast'
import { useThemeStore } from '@/features/settings/theme'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type AppearanceAsset, assetUrl, useAppearanceAssets, useDeleteAsset, useUploadAsset } from './api'
import type { Background } from './apply'
import { GradientPicker } from './GradientPicker'

/** What the file picker offers (no SVG); the server checks the content anyway. */
export const BACKGROUND_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/webm,video/mp4'

function Thumb({ asset, chosen, onChoose, onDelete }: { asset: AppearanceAsset; chosen: boolean; onChoose: () => void; onDelete: () => void }) {
  // A still for video isn't made on the server (that needs ffmpeg): a video shows an icon.
  const still = asset.media === 'video' ? null : asset.poster_url ? assetUrl(asset.id, { poster: true }) : assetUrl(asset.id)
  return (
    <li className="relative">
      <button type="button" onClick={onChoose} aria-pressed={chosen} aria-label={t('Use {name}', { name: asset.filename })}
        className={cn('flex h-16 w-24 items-center justify-center overflow-hidden rounded-control bg-surface-2 bg-cover bg-center shadow-soft transition-transform hover:scale-[1.03]',
          chosen && 'ring-2 ring-accent ring-offset-2 ring-offset-card')}
        style={still ? { backgroundImage: `url("${still}")` } : undefined}>
        {!still && <Film className="h-6 w-6 text-muted" />}
      </button>
      <button type="button" onClick={onDelete} aria-label={t('Delete {name}', { name: asset.filename })}
        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted shadow-soft hover:text-error">
        <Trash2 className="h-3 w-3" />
      </button>
    </li>
  )
}

export function BackgroundCard() {
  const background = useThemeStore((s) => s.background)
  const accent = useThemeStore((s) => s.accent)
  const set = useThemeStore((s) => s.set)
  const change = (patch: Partial<Background>) => set({ background: { ...useThemeStore.getState().background, ...patch } })
  const assets = useAppearanceAssets()
  const uploads = (assets.data ?? []).filter((a) => a.kind === 'background')
  const upload = useUploadAsset()
  const remove = useDeleteAsset()
  const input = useRef<HTMLInputElement>(null)

  const onFile = (file: File | undefined) => {
    if (!file) return
    upload.mutate({ file, kind: 'background' }, {
      onSuccess: (asset) => change({ kind: 'upload', asset_id: asset.id }),
      onError: (err) => toast({ message: t("Couldn't use this file: {error}", { error: errorMessage(err) }) }),
    })
  }
  const chosen = uploads.find((a) => a.id === background.asset_id)
  const animated = background.kind === 'gradient' || (background.kind === 'upload' && chosen?.media !== 'image')

  return (
    <Card>
      <CardHeader title={t('Background')} description={t('Behind the whole app, including your chats.')} />
      <CardBody className="flex flex-col gap-(--card-y)">
        <Segmented<Background['kind']> label={t('Background')} value={background.kind} onChange={(kind) => change({ kind })}
          className="max-md:flex max-md:w-full"
          options={[
            { value: 'none', label: t('None') },
            // Phones show the short name, so the three fit side by side.
            { value: 'gradient', ariaLabel: t('Animated gradient'), label: <><span className="md:hidden">{t('Gradient')}</span><span className="max-md:hidden">{t('Animated gradient')}</span></> },
            { value: 'upload', label: t('Picture or video') },
          ]} />

        {background.kind === 'gradient' && <GradientPicker background={background} accent={accent} onChange={change} />}

        {background.kind === 'upload' && (
          <div className="flex flex-col gap-3">
            {uploads.length > 0 && (
              <ul className="flex flex-wrap gap-3">
                {uploads.map((a) => (
                  <Thumb key={a.id} asset={a} chosen={a.id === background.asset_id}
                    onChoose={() => change({ asset_id: a.id })}
                    onDelete={() => remove.mutate(a.id, { onError: (err) => toast({ message: errorMessage(err) }) })} />
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input ref={input} type="file" accept={BACKGROUND_ACCEPT} className="hidden" aria-hidden tabIndex={-1}
                onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
              <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>
                {t('Upload')}
              </Button>
              <span className="text-[12px] text-muted">{t('PNG, JPEG, WebP, AVIF or GIF up to 15 MB; WebM or MP4 up to 40 MB. Photo details such as the location are removed.')}</span>
            </div>
          </div>
        )}

        {background.kind !== 'none' && (
          <>
            {/* A small group label: the controls under it are what matters. */}
            <section aria-labelledby="background-effects" className="-mx-(--card-x) flex flex-col gap-3 border-t border-border px-(--card-x) pt-(--card-y)">
              <h4 id="background-effects" className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">{t('Effects')}</h4>
              <SliderField label={t('Blur')} min={0} max={40} step={1} value={background.blur}
                format={(v) => `${v} px`} onChange={(v) => change({ blur: Math.round(v) })} />
              <SliderField label={t('Dim')} min={0} max={90} step={5} value={background.dim}
                format={(v) => `${v} %`} onChange={(v) => change({ dim: Math.round(v) })} />
              {background.kind === 'upload' && (
                <FieldRow label={t('Fit')}>
                  <Segmented<Background['fit']> size="sm" label={t('Fit')} value={background.fit} onChange={(fit) => change({ fit })}
                    options={[
                      { value: 'cover', label: t('Fill') },
                      { value: 'contain', label: t('Fit') },
                      { value: 'tile', label: t('Tile') },
                    ]} />
                </FieldRow>
              )}
            </section>
            {/* Not an effect: whether it moves at all on a phone. A row of its own. */}
            {animated && (
              <SettingRow className="-mx-(--card-x) -mb-(--card-y) border-t border-border" title={t('Animate on phones too')}
                description={t('Phones show a still picture to save battery. With reduced motion turned on in your system, it is always still.')}
                checked={background.animate_on_phones} onCheckedChange={(v) => change({ animate_on_phones: v })} />
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
