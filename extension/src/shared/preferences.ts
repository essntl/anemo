/**
 * The extension's own preferences (kept in chrome.storage.local). What Anemo itself
 * decides (models, the default chat mode, ...) is read from the server instead.
 */

/** Optional features. Those that need an extra permission start off and ask for it when
 *  switched on; the others start on. */
export interface Features {
  notifications: boolean
  /** Skip Discord while you use this computer (needs the `idle` permission). */
  discordSkip: boolean
  focusBlocking: boolean
  youtubeNotes: boolean
  browserControl: boolean
}

export type NotificationType = 'reminder' | 'calendar' | 'agent' | 'approval' | 'focus' | 'automation'

export interface Preferences {
  features: Features
  notificationTypes: Record<NotificationType, boolean>
  /** Target language for translations (BCP 47 code). */
  targetLanguage: string
}

export const DEFAULT_PREFERENCES: Preferences = {
  features: {
    notifications: true,
    discordSkip: false,
    focusBlocking: false,
    youtubeNotes: false,
    browserControl: false,
  },
  notificationTypes: { reminder: true, calendar: true, agent: true, approval: true, focus: true, automation: true },
  targetLanguage: 'en',
}

/** Stored preferences merged over the defaults (new fields get their default). */
export function withDefaults(stored: Partial<Preferences> | undefined): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    features: { ...DEFAULT_PREFERENCES.features, ...stored?.features },
    notificationTypes: { ...DEFAULT_PREFERENCES.notificationTypes, ...stored?.notificationTypes },
  }
}
