/**
 * Which permissions each optional feature needs. They are requested at the moment the
 * feature is switched on (a click), and given back when it is switched off.
 */
import type { Features } from './preferences'

export type FeatureKey = keyof Features

export const FEATURE_PERMISSIONS: Record<FeatureKey, chrome.permissions.Permissions> = {
  notifications: {},
  discordSkip: { permissions: ['idle'] },
  focusBlocking: { permissions: ['declarativeNetRequestWithHostAccess'] },
  youtubeNotes: { origins: ['https://www.youtube.com/*'] },
  // The debugger itself comes with the browser-control build's install (Chrome doesn't
  // offer it as an optional permission); the normal build has no browser control.
  browserControl: { permissions: ['tabs', 'tabGroups'], origins: ['https://*/*', 'http://*/*'] },
}

function needsAny(p: chrome.permissions.Permissions): boolean {
  return (p.permissions?.length ?? 0) + (p.origins?.length ?? 0) > 0
}

/** Ask for a feature's permissions (call it straight from a click). True when granted. */
export async function requestFeature(key: FeatureKey): Promise<boolean> {
  const wanted = FEATURE_PERMISSIONS[key]
  if (!needsAny(wanted)) return true
  // Refused, or not requestable at all (Chrome throws then): off, never an uncaught error.
  return chrome.permissions.request(wanted).catch(() => false)
}

export async function hasFeaturePermissions(key: FeatureKey): Promise<boolean> {
  const wanted = FEATURE_PERMISSIONS[key]
  if (!needsAny(wanted)) return true
  return chrome.permissions.contains(wanted).catch(() => false)
}

/** Give a feature's permissions back. The Anemo address is never removed here. */
export async function releaseFeature(key: FeatureKey): Promise<void> {
  const wanted = FEATURE_PERMISSIONS[key]
  if (!needsAny(wanted)) return
  if (key === 'browserControl') {
    // Stopped first: the worker detaches from every tab when this goes.
    await chrome.storage.session.set({ browserActive: null }).catch(() => undefined)
  }
  if (key === 'focusBlocking' && chrome.declarativeNetRequest) {
    // No blocking rule may outlive the switch.
    const rules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => [])
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((r) => r.id) }).catch(() => undefined)
  }
  await chrome.permissions.remove(wanted).catch(() => false)
}
