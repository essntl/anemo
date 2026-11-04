/**
 * Push notifications on this device (Web Push). Unlike desktop notifications they
 * arrive while Anemo is closed: the browser's push service wakes our service worker
 * (public/sw.js), which shows them. Turning push on subscribes this browser and
 * registers the subscription with the server as a notification destination.
 */
import { api, unwrap } from '@/api/client'

export type PushSupport =
  | 'ok'
  | 'unsupported' // no Push API in this browser
  | 'insecure' // needs HTTPS (or localhost)
  | 'blocked' // notifications are blocked for this site
  | 'ios-install' // iPhone/iPad: only works once added to the Home Screen
  | 'dev' // the dev server does not register the service worker

const FLAG = 'anemo.pushOn' // this browser has push on (desktop notifications then step aside)

export interface PushEnv {
  userAgent: string
  maxTouchPoints: number
  standalone: boolean
  secure: boolean
  hasPush: boolean
  permission: NotificationPermission | null
  dev: boolean
}

function currentEnv(): PushEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone:
      typeof window !== 'undefined' &&
      ((typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
        (nav as Navigator & { standalone?: boolean } | undefined)?.standalone === true),
    secure: typeof window !== 'undefined' && window.isSecureContext,
    hasPush:
      typeof window !== 'undefined' && !!nav && 'serviceWorker' in nav && 'PushManager' in window && 'Notification' in window,
    permission: typeof Notification === 'undefined' ? null : Notification.permission,
    dev: import.meta.env.DEV,
  }
}

/** iPhone, iPad, or an iPad that says it is a Mac (iPadOS does by default). */
export function isIOS(userAgent: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
}

/** Whether push can be turned on here, and if not, why. */
export function pushSupport(env: PushEnv = currentEnv()): PushSupport {
  if (!env.secure) return 'insecure'
  if (isIOS(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'ios-install'
  if (!env.hasPush) return 'unsupported'
  if (env.dev) return 'dev'
  if (env.permission === 'denied') return 'blocked'
  return 'ok'
}

/** A readable name for this device, e.g. "Chrome on Android" or "Safari on iPhone". */
export function deviceName(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser'
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null
  return system ? `${browser} on ${system}` : browser
}

/** The server key as PushManager.subscribe() wants it. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/** SHA-256 of the subscription address, as the server lists it (`endpoint_hash`). */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function setFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, 'on')
    else localStorage.removeItem(FLAG)
  } catch {
    // storage not available (private mode): only the desktop/push overlap is affected
  }
}

/** This browser receives push notifications (so it needs no desktop notifications). */
export function pushOnHere(): boolean {
  try {
    return localStorage.getItem(FLAG) === 'on'
  } catch {
    return false
  }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // The worker is registered on load (main.tsx); wait for it, but not forever.
  const ready = navigator.serviceWorker.ready
  const timeout = new Promise<never>((_, reject) =>
    window.setTimeout(() => reject(new Error('The app’s service worker is not running. Reload the page and try again.')), 10_000),
  )
  return Promise.race([ready, timeout])
}

/** This browser's current subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null
  try {
    const reg = await registration()
    const sub = await reg.pushManager.getSubscription()
    setFlag(sub !== null)
    return sub
  } catch {
    return null
  }
}

export class PushPermissionError extends Error {}

/**
 * Turn push on here: ask for permission, subscribe with the server's key and register
 * the subscription. Throws PushPermissionError when the user does not allow it.
 * The registration call may ask for the password (see withReauth in the caller).
 */
export async function subscribeThisDevice(register: (sub: PushSubscriptionJSON) => Promise<unknown>): Promise<void> {
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new PushPermissionError('The browser did not give permission.')
  const { public_key } = unwrap(await api.GET('/api/push/key'))
  const key = base64UrlToBytes(public_key)
  const reg = await registration()
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe() // made with another server's key (e.g. a restored backup)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await register(sub.toJSON())
  setFlag(true)
}

/** Stop push in this browser. Returns the address it had, to remove it on the server. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const reg = await registration()
  const sub = await reg.pushManager.getSubscription()
  setFlag(false)
  if (!sub) return null
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  return endpoint
}
