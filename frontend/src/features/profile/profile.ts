/**
 * Who you are in the app: the display name (Settings > Profile, else the login name) and
 * the avatar. Read from the cached settings and /auth/me, so no extra request.
 */
import { useMe } from '@/features/auth/api'
import { useSettings } from '@/features/settings/api'

export interface Profile {
  /** The display name, or the login name when none is set. */
  name: string
  avatarId: string | null
}

export function useProfile(): Profile {
  const me = useMe()
  const settings = useSettings()
  const profile = settings.data?.profile
  return {
    name: profile?.display_name || me.data?.username || '',
    avatarId: profile?.avatar_id ?? null,
  }
}

/** Up to two letters: the first of the first two words ("Artem Kotov" → "AK"), else the
 *  first two of one word ("artem" → "AR"). */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/u).filter(Boolean)
  if (words.length === 0) return ''
  const letters = words.length > 1 ? [words[0], words[1]].map((w) => Array.from(w)[0]) : Array.from(words[0]).slice(0, 2)
  return letters.join('').toLocaleUpperCase()
}
