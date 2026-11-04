import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, deviceName, endpointHash, isIOS, type PushEnv, pushSupport } from './push'
import { isAppPath } from './useServiceWorkerLinks'

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
}

describe('device names', () => {
  it('names the browser and the system', () => {
    expect(deviceName(UA.chromeAndroid)).toBe('Chrome on Android')
    expect(deviceName(UA.safariIphone)).toBe('Safari on iPhone')
    expect(deviceName(UA.ipadAsMac, 5)).toBe('Safari on iPad')
    expect(deviceName(UA.ipadAsMac, 0)).toBe('Safari on Mac')
    expect(deviceName(UA.firefoxWindows)).toBe('Firefox on Windows')
    expect(deviceName(UA.edgeWindows)).toBe('Edge on Windows')
    expect(deviceName(UA.chromeMac)).toBe('Chrome on Mac')
    expect(deviceName(UA.samsung)).toBe('Samsung Internet on Android')
    expect(deviceName(UA.firefoxLinux)).toBe('Firefox on Linux')
    expect(deviceName('curl/8')).toBe('Browser')
  })
  it('recognises iPhones and iPads, also an iPad that says it is a Mac', () => {
    expect(isIOS(UA.safariIphone)).toBe(true)
    expect(isIOS(UA.ipadAsMac, 5)).toBe(true)
    expect(isIOS(UA.ipadAsMac, 0)).toBe(false)
    expect(isIOS(UA.chromeAndroid)).toBe(false)
  })
})

describe('whether push can be turned on', () => {
  const ok: PushEnv = {
    userAgent: UA.chromeAndroid,
    maxTouchPoints: 5,
    standalone: false,
    secure: true,
    hasPush: true,
    permission: 'default',
    dev: false,
  }
  it('works in a normal browser over HTTPS', () => expect(pushSupport(ok)).toBe('ok'))
  it('explains why not', () => {
    expect(pushSupport({ ...ok, secure: false })).toBe('insecure')
    expect(pushSupport({ ...ok, hasPush: false })).toBe('unsupported')
    expect(pushSupport({ ...ok, permission: 'denied' })).toBe('blocked')
    expect(pushSupport({ ...ok, dev: true })).toBe('dev')
  })
  it('on iOS, only from the Home Screen', () => {
    const iphone = { ...ok, userAgent: UA.safariIphone, hasPush: false }
    expect(pushSupport(iphone)).toBe('ios-install')
    expect(pushSupport({ ...iphone, standalone: true, hasPush: true })).toBe('ok')
  })
})

describe('keys and addresses', () => {
  it('decodes the server key from base64url', () => {
    expect([...base64UrlToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
    expect(base64UrlToBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')).toHaveLength(65)
  })
  it('hashes the subscription address like the server', async () => {
    // The SHA-256 test vector for "abc".
    expect(await endpointHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('only follows links inside the app', () => {
    expect(isAppPath('/c/123')).toBe(true)
    expect(isAppPath('//evil.example/x')).toBe(false)
    expect(isAppPath('https://evil.example')).toBe(false)
    expect(isAppPath(42)).toBe(false)
  })
})
