import type { ApiError } from '@/shared/api'
import type { Step } from '@/shared/connect'

/** What to do about a failed step, in words. */
export function helpFor(step: Step | 'permission', error: ApiError | null, extensionId: string): { title: string; body: string } {
  if (step === 'permission') {
    return {
      title: 'The extension needs your permission to reach Anemo',
      body: 'Click Connect again and choose Allow. The extension only gets access to this one address.',
    }
  }
  const kind = error?.kind
  switch (kind) {
    case 'offline':
      return { title: 'You are offline', body: 'Connect to the internet (or your home network) and try again.' }
    case 'unreachable':
      return {
        title: 'Nothing answered at this address',
        body: 'Check the address. If Anemo runs at home, are you on that network or its VPN? Is the proxy host in Nginx Proxy Manager online?',
      }
    case 'timeout':
      return { title: 'Anemo took too long to answer', body: 'It may be starting up or very busy. Try again in a minute.' }
    case 'permission':
      return { title: 'Access to this address was not allowed', body: 'Click Connect again and choose Allow.' }
    case 'server_down':
      return {
        title: 'Your proxy answered, but Anemo didn’t',
        body: 'Nginx Proxy Manager or Cloudflare is up, Anemo behind it is not (502/503/52x). Check `docker compose ps` on the server.',
      }
    case 'challenge':
      return {
        title: 'Cloudflare is asking for a browser check',
        body: 'The extension can’t answer Cloudflare challenges. Turn off Bot Fight Mode / “Under Attack” for this host, or add a WAF rule that skips challenges for /api/*.',
      }
    case 'html':
      return {
        title: 'A web page came back instead of Anemo',
        body: 'Use the exact address you open Anemo at. A login page in front of Anemo (an access gateway) also causes this.',
      }
    case 'not_anemo':
      return { title: 'This isn’t Anemo', body: 'Something answered at this address, but not Anemo’s API. Check the address.' }
    case 'unauthorized':
      return {
        title: 'The token doesn’t work',
        body: 'It was revoked, or mistyped. In Anemo open Settings → General → Extension and device tokens, create a new one and paste it here.',
      }
    case 'origin':
      return {
        title: 'Anemo refuses requests from this extension',
        body: `Update Anemo to a version with API tokens. If you set EXTENSION_IDS in its .env, add this extension’s id: ${extensionId}.`,
      }
    default:
      return { title: 'Couldn’t connect', body: error?.message ?? 'Something went wrong.' }
  }
}
