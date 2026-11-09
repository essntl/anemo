import { BROWSER_CONTROL } from '@/shared/env'
import type { FeatureKey } from '@/shared/permissions'

export interface FeatureInfo {
  key: FeatureKey
  label: string
  description: string
  /** What Chrome will ask for, in words. */
  asks?: string
  /** False while the feature is still being built. */
  available: boolean
}

/** The optional features, in the order they are listed (browser control only in its own build). */
const ALL_FEATURES: FeatureInfo[] = [
  { key: 'notifications', label: 'Notifications', description: 'Reminders, approvals, finished agent runs and focus as Chrome notifications.', available: true },
  {
    key: 'discordSkip',
    label: 'Skip Discord while I’m here',
    description: 'Anemo doesn’t send to Discord while the extension is connected and you used this computer in the last 5 minutes.',
    asks: 'whether this computer is in use (idle detection)',
    available: true,
  },
  {
    key: 'focusBlocking',
    label: 'Block distractions during focus',
    description: 'Sites on your list show the remaining focus time instead.',
    asks: 'blocking and redirecting sites (each site is asked for when you add it, in the Focus tab)',
    available: true,
  },
  { key: 'youtubeNotes', label: 'YouTube notes', description: 'Timestamped notes and transcripts for YouTube videos (the Notes tab).', asks: 'access to youtube.com', available: true },
  {
    key: 'browserControl',
    label: 'Browser control',
    description: 'Let Anemo’s agent use tabs it opens in an “Anemo” tab group of this Chrome, with your logins. Once allowed, you still switch it on each time (“Browser control” below); it goes off after 10 minutes without use.',
    asks: 'tabs and tab groups, all sites (the debugger came with this build)',
    available: true,
  },
]

export const FEATURES: FeatureInfo[] = ALL_FEATURES.filter((f) => f.key !== 'browserControl' || BROWSER_CONTROL)
