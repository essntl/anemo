/**
 * What the Git view says when a read failed, by the server's error code: a title, one
 * sentence, and what can be done about it. The server's own message (English, with the
 * specifics the computer gave) is kept as a detail for the codes where it says more.
 */
import { ApiError, errorMessage } from '@/api/client'
import { t } from '@/lib/i18n'

export type GitErrorKind = 'update' | 'offline' | 'trust' | 'refused' | 'signin' | 'missing' | 'busy' | 'failed'

export interface GitErrorInfo {
  kind: GitErrorKind
  title: string
  description: string
  /** The server's message, for the codes where it adds something (what the computer said). */
  detail: string | null
  /** Retry: read again. Devices: open Settings → Devices. */
  action: 'retry' | 'devices'
}

/** `device`: the computer's name; `remote`: a GitHub repository that isn't cloned there (it needs a newer Anemo Desktop). */
export function gitErrorInfo(err: unknown, device: string, remote: boolean): GitErrorInfo {
  const code = err instanceof ApiError ? err.code : ''
  const message = errorMessage(err)
  switch (code) {
    case 'git_unsupported':
      return {
        kind: 'update', action: 'retry', detail: null,
        title: t('Update Anemo Desktop on “{device}”', { device }),
        description: remote
          ? t('Reading GitHub repositories that aren’t cloned needs Anemo Desktop 1.6.0 or later on that computer.')
          : t('The Git view needs Anemo Desktop 1.5.0 or later on that computer.'),
      }
    case 'device_offline':
      return {
        kind: 'offline', action: 'retry', detail: null,
        title: t('“{device}” is offline', { device }),
        description: t('Turn the computer on and make sure Anemo Desktop is running there, then try again.'),
      }
    case 'device_not_trusted':
      return {
        kind: 'trust', action: 'devices', detail: null,
        title: t('“{device}” isn’t trusted', { device }),
        description: t('Only computers you trust can be read. You can trust it in Settings → Devices.'),
      }
    case 'device_refused':
      return {
        kind: 'refused', action: 'retry', detail: message,
        title: t('“{device}” didn’t let Anemo read it', { device }),
        description: t('In Anemo Desktop on that computer, turn on “Share Claude Code jobs with Anemo” (watching alone isn’t enough), then try again.'),
      }
    case 'device_unauthenticated':
      return {
        kind: 'signin', action: 'retry', detail: null,
        title: t('“{device}” isn’t signed in to GitHub', { device }),
        description: t('Run “gh auth login” in a terminal on that computer, then try again.'),
      }
    case 'not_found':
      return {
        kind: 'missing', action: 'retry', detail: message,
        title: t('Repository not found'),
        description: remote
          ? t('GitHub has no such repository, or the account signed in on that computer can’t see it.')
          : t('There’s no such folder in the computer’s projects folder, or it isn’t a git repository.'),
      }
    case 'device_busy':
      return {
        kind: 'busy', action: 'retry', detail: null,
        title: t('“{device}” is busy', { device }),
        description: t('It is still answering another request. Try again in a moment.'),
      }
    default:
      return {
        kind: 'failed', action: 'retry', detail: message,
        title: t('Couldn’t read the repository'),
        description: t('Something went wrong on the way to the computer or on it.'),
      }
  }
}
