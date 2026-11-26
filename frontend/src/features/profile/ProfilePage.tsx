/** Settings > Profile: your display name and avatar. */
import { useRef, useState } from 'react'
import { Trash2, Upload } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/toast'
import { useRemoveAvatar, useSetAvatar } from '@/features/appearance/api'
import { useMe } from '@/features/auth/api'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { t } from '@/lib/i18n'
import { Avatar } from './Avatar'
import { AvatarCropper } from './AvatarCropper'

/** What the file picker offers (no SVG); the server checks the content anyway. */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif'

function NameForm({ initial, username }: { initial: string; username: string }) {
  const settings = useSettings()
  const save = useSaveSection('profile')
  const [name, setName] = useState(initial)
  const dirty = name.trim() !== initial
  const submit = () => {
    const profile = settings.data?.profile
    if (!profile) return
    save.mutate({ ...profile, display_name: name.trim() }, {
      onSuccess: () => toast({ message: t('Name saved.') }),
      onError: (err) => toast({ message: errorMessage(err) }),
    })
  }
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); submit() }}>
      <label htmlFor="profile-display-name" className="text-[13px] font-medium">{t('Display name')}</label>
      {/* The field is as wide as a name needs, with its Save button beside it. */}
      <div className="flex max-w-md items-center gap-2">
        <Input id="profile-display-name" value={name} maxLength={60} placeholder={username} onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1" />
        {/* Quiet until there is something to save, then the accent: not a washed-out blue. */}
        <Button type="submit" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={save.isPending}>{t('Save')}</Button>
      </div>
      <span className="text-[12px] text-muted">{t('Shown in the sidebar. Empty: your login name ({username}).', { username })}</span>
    </form>
  )
}

function AvatarForm({ hasAvatar }: { hasAvatar: boolean }) {
  // The picture being cropped, and an object URL to show it (freed when the cropper closes).
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null)
  const pick = (file: File | undefined) => {
    if (picked) URL.revokeObjectURL(picked.url)
    setPicked(file ? { file, url: URL.createObjectURL(file) } : null)
  }
  const input = useRef<HTMLInputElement>(null)
  const setAvatar = useSetAvatar()
  const remove = useRemoveAvatar()
  return (
    <div className="flex items-center gap-4">
      <Avatar size={64} className="shrink-0" />
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept={AVATAR_ACCEPT} className="hidden" aria-hidden tabIndex={-1}
            onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
          <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => input.current?.click()}>
            {hasAvatar ? t('Change avatar') : t('Upload avatar')}
          </Button>
          {hasAvatar && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onError: (err) => toast({ message: errorMessage(err) }) })}>
              {t('Remove')}
            </Button>
          )}
        </div>
        <span className="text-[12px] text-muted">{t('PNG, JPEG, WebP, AVIF or GIF, up to 10 MB. Without one, your initials are shown.')}</span>
      </div>
      <AvatarCropper key={picked?.url} file={picked?.file ?? null} url={picked?.url ?? null} saving={setAvatar.isPending}
        onCancel={() => pick(undefined)}
        onDone={(chosen, crop) => setAvatar.mutate({ file: chosen, crop }, {
          onSuccess: () => { pick(undefined); toast({ message: t('Avatar saved.') }) },
          onError: (err) => toast({ message: t("Couldn't use this picture: {error}", { error: errorMessage(err) }) }),
        })} />
    </div>
  )
}

export function ProfilePage() {
  const settings = useSettings()
  const me = useMe()
  const profile = settings.data?.profile
  return (
    <div className="flex flex-col gap-(--card-gap)">
      <Card>
        <CardHeader title={t('Profile')} description={t('Your name and picture, shown in the sidebar’s account row.')} />
        <CardBody className="flex flex-col gap-(--card-y)">
          <AvatarForm hasAvatar={Boolean(profile?.avatar_id)} />
          <div aria-hidden className="-mx-(--card-x) h-px bg-border" />
          {profile && <NameForm key={profile.display_name} initial={profile.display_name} username={me.data?.username ?? ''} />}
        </CardBody>
      </Card>
    </div>
  )
}
