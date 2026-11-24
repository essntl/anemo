/** Settings > Appearance > Background: none, an animated gradient or an upload; blur, dim, fit. */
import { useRef, type CSSProperties, type ReactNode } from 'react'
import { Film, Trash2, Upload } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { useThemeStore } from '@/features/settings/theme'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type AppearanceAsset, assetUrl, useAppearanceAssets, useDeleteAsset, useUploadAsset } from './api'
import type { Background } from './apply'
import { GRADIENTS, gradientColors } from './gradients'

/** What the file picker offers (no SVG); the server checks the content anyway. */
export const BACKGROUND_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/webm,video/mp4'

function Thumb({ asset, chosen, onChoose, onDelete }: { asset: AppearanceAsset; chosen: boolean; onChoose: () => void; onDelete: () => void }) {
  // A still for video isn't made on the server (that needs ffmpeg): a video shows an icon.
  const still = asset.media === 'video' ? null : asset.poster_url ? assetUrl(asset.id, { poster: true }) : assetUrl(asset.id)
  return (
    <li className="relative">
      <button type="button" onClick={onChoose} aria-pressed={chosen} aria-label={t('Use {name}', { name: asset.filename })}
        className={cn('flex h-20 w-28 items-center justify-center overflow-hidden rounded-control border-2 bg-surface-2 bg-cover bg-center',
          chosen ? 'border-accent' : 'border-transparent hover:border-border-strong')}
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-28 shrink-0 text-[13px] text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
    </div>
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
      <CardBody className="flex flex-col gap-5">
        <Segmented<Background['kind']> label={t('Background')} value={background.kind} onChange={(kind) => change({ kind })}
          options={[
            { value: 'none', label: t('None') },
            { value: 'gradient', label: t('Animated gradient') },
            { value: 'upload', label: t('Picture or video') },
          ]} />

        {background.kind === 'gradient' && (
          <ul className="flex flex-wrap gap-3">
            {GRADIENTS.map((g) => {
              const [a, b, c] = gradientColors(g.id, accent)
              return (
                <li key={g.id}>
                  <button type="button" aria-pressed={background.gradient === g.id} onClick={() => change({ gradient: g.id })}
                    className={cn('flex h-20 w-28 items-end rounded-control border-2 p-2 text-[12px] font-medium text-white',
                      background.gradient === g.id ? 'border-accent' : 'border-transparent hover:border-border-strong')}
                    style={{ background: `linear-gradient(135deg, ${a}, ${b}, ${c})` } as CSSProperties}>
                    <span className="drop-shadow">{t(g.label)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

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
          <div className="flex flex-col gap-4">
            <Row label={t('Blur')}>
              <Slider label={t('Blur')} min={0} max={40} step={1} value={background.blur} className="flex-1"
                valueText={(v) => `${Math.round(v)} px`} onChange={(v) => change({ blur: Math.round(v) })} />
              <span className="w-12 text-right text-[12.5px] tabular-nums text-muted">{background.blur} px</span>
            </Row>
            <Row label={t('Dim')}>
              <Slider label={t('Dim')} min={0} max={90} step={5} value={background.dim} className="flex-1"
                valueText={(v) => `${Math.round(v)} %`} onChange={(v) => change({ dim: Math.round(v) })} />
              <span className="w-12 text-right text-[12.5px] tabular-nums text-muted">{background.dim} %</span>
            </Row>
            {background.kind === 'upload' && (
              <Row label={t('Fit')}>
                <Segmented<Background['fit']> size="sm" label={t('Fit')} value={background.fit} onChange={(fit) => change({ fit })}
                  options={[
                    { value: 'cover', label: t('Fill') },
                    { value: 'contain', label: t('Fit') },
                    { value: 'tile', label: t('Tile') },
                  ]} />
              </Row>
            )}
            {animated && (
              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-[13.5px] font-medium">{t('Animate on phones too')}</span>
                  <span className="block text-[12.5px] text-muted">{t('Phones show a still picture to save battery. With reduced motion turned on in your system, it is always still.')}</span>
                </span>
                <Switch label={t('Animate on phones too')} checked={background.animate_on_phones} onChange={(v) => change({ animate_on_phones: v })} />
              </label>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
