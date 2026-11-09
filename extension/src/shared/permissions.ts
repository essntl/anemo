/**
 * Which permissions each optional feature needs. They are requested at the moment the
 * feature is switched on (a click), and given back when it is switched off.
 */
import type { Features } from './preferences'

export type FeatureKey = keyof Features

export const FEATURE_PERMISSIONS: Record<FeatureKey, chrome.permissions.Permissions> = {
  notifications: {},
  discordSkip: { permissions: ['idle'] },
  focusBlocking: { permissions: ['declarativeNetRequest'] },
  youtubeNotes: { origins: ['https://www.youtube.com/*'] },
  browserControl: { permissions: ['debugger', 'tabs', 'tabGroups'], origins: ['https://*/*', 'http://*/*'] },
}

function needsAny(p: chrome.permissions.Permissions): boolean {
  return (p.permissions?.length ?? 0) + (p.origins?.length ?? 0) > 0
}

/** Ask for a feature's permissions (call it straight from a click). True when granted. */
export async function requestFeature(key: FeatureKey): Promise<boolean> {
  const wanted = FEATURE_PERMISSIONS[key]
  if (!needsAny(wanted)) return true
  return chrome.permissions.request(wanted)
}

export async function hasFeaturePermissions(key: FeatureKey): Promise<boolean> {
  const wanted = FEATURE_PERMISSIONS[key]
  if (!needsAny(wanted)) return true
  return chrome.permissions.contains(wanted)
}

/** Give a feature's permissions back. The Anemo address is never removed here. */
export async function releaseFeature(key: FeatureKey): Promise<void> {
  const wanted = FEATURE_PERMISSIONS[key]
  if (!needsAny(wanted)) return
  if (key === 'focusBlocking' && chrome.declarativeNetRequest) {
    // No blocking rule may outlive the switch.
    const rules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => [])
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((r) => r.id) }).catch(() => undefined)
  }
  await chrome.permissions.remove(wanted).catch(() => false)
}
