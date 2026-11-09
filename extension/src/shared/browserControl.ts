/**
 * Browser control (feature 12): Anemo's agent using the user's own Chrome, in tabs it opens
 * in an "Anemo" tab group. The pure parts: the blocklist, which pages count as a person
 * check, how the page's elements are listed for the agent.
 */

/** The default blocklist (your answer 47): banking and payment, government and tax,
 *  webmail, password managers, Google's account pages, the Web Store. Editable. */
export const DEFAULT_BLOCKLIST: string[] = [
  // banking and payment (and any address with "bank" in its name, see isBlocked)
  'paypal.com', 'stripe.com', 'klarna.com', 'wise.com', 'revolut.com', 'vipps.no', 'bankid.no', 'dnb.no', 'nordea.no', 'nordea.com',
  'sparebank1.no', 'handelsbanken.no', 'americanexpress.com', 'visa.com', 'mastercard.com', 'coinbase.com', 'binance.com',
  // government and tax
  'skatteetaten.no', 'altinn.no', 'nav.no', 'idporten.no', 'helsenorge.no', 'norge.no', 'gov.uk', 'irs.gov', 'usa.gov', 'europa.eu',
  // webmail
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.proton.me', 'mail.yahoo.com', 'fastmail.com', 'mail.aol.com',
  // password managers
  '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com', 'proton.me/pass',
  // accounts and the Web Store
  'accounts.google.com', 'myaccount.google.com', 'chromewebstore.google.com', 'chrome.google.com',
]

function hostOf(url: string): { host: string; path: string; protocol: string } | null {
  try {
    const u = new URL(url)
    return { host: u.hostname.toLowerCase().replace(/^www\./, ''), path: u.pathname, protocol: u.protocol }
  } catch {
    return null
  }
}

/**
 * Why the agent may not use this address, or null. Never: anything but http(s) (Chrome's
 * own pages, other extensions, files), Anemo itself (the agent could approve its own
 * actions there), the blocklist (an entry covers its subdomains; "site/path" covers that
 * path), government domains (.gov) and addresses with "bank" in their name.
 */
export function blockedReason(url: string, blocklist: string[], anemoUrl: string | null): string | null {
  const u = hostOf(url)
  if (!u) return 'That isn’t a web address.'
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only web pages (http and https) can be used.'
  const anemo = anemoUrl ? hostOf(anemoUrl) : null
  if (anemo && anemo.host === u.host) return 'Anemo itself can’t be used through browser control.'
  if (/(^|\.)gov(\.[a-z]{2})?$/.test(u.host)) return `${u.host} is a government site: browser control never uses those.`
  if (/bank/.test(u.host)) return `${u.host} looks like a bank: browser control never uses those.`
  for (const entry of blocklist) {
    const [site, ...rest] = entry.toLowerCase().replace(/^www\./, '').split('/')
    const path = rest.length ? `/${rest.join('/')}` : ''
    if ((u.host === site || u.host.endsWith(`.${site}`)) && (!path || u.path.startsWith(path))) {
      return `${u.host} is on your browser-control blocklist.`
    }
  }
  return null
}

/** An entry for the blocklist from what was typed: "https://www.x.com/a" → "x.com/a". */
export function normalizeEntry(input: string): string | null {
  let text = input.trim().toLowerCase()
  if (!text) return null
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`
  try {
    const u = new URL(text)
    const host = u.hostname.replace(/^www\./, '')
    // One-word names (intranet hosts, localhost) are fine here.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null
    const path = u.pathname.replace(/\/+$/, '')
    return path ? `${host}${path}` : host
  } catch {
    return null
  }
}

/** Text that says the site wants to know whether you are a person. */
const PERSON_CHECK_TEXT = /verify (that )?you are (a )?human|are you a robot|i'?m not a robot|checking (if the site connection is secure|your browser)|complete the security check|press (and|&) hold|unusual traffic from your computer/i
/** Frames of the usual check widgets. */
const PERSON_CHECK_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha-delivery/i

export function looksLikePersonCheck(text: string, frameUrls: string[]): boolean {
  return PERSON_CHECK_TEXT.test(text.slice(0, 5000)) || frameUrls.some((u) => PERSON_CHECK_FRAME.test(u))
}

/** Roles in the accessibility tree the agent can act on. */
export const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'switch', 'slider', 'spinbutton', 'listbox', 'treeitem',
])

export interface ElementInfo {
  ref: number
  role: string
  name: string
  href: string | null
  /** A plain link to a web page (no download, no script): following it is only navigating. */
  follow: boolean
  password: boolean
  value: string | null
}

/** How an element is listed for the agent: `[3] link "More" → https://…`. */
export function elementLine(e: ElementInfo): string {
  const name = e.name.replace(/\s+/g, ' ').trim().slice(0, 100)
  let line = `[${e.ref}] ${e.role}${name ? ` "${name}"` : ''}`
  if (e.href) line += ` → ${e.href.slice(0, 200)}`
  if (e.password) line += ' (password: never typed into)'
  else if (e.value) line += ` (now: "${e.value.slice(0, 60)}")`
  return line
}

/** Whether a link only navigates: http(s), not a download. */
export function isFollowableLink(role: string, href: string | null, attributes: Record<string, string>): boolean {
  if (role !== 'link' || !href) return false
  if ('download' in attributes) return false
  try {
    const u = new URL(href)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return !/\.(zip|exe|dmg|pkg|msi|apk|iso|tar|gz|7z|rar|deb|rpm)$/i.test(u.pathname)
  } catch {
    return false
  }
}

export const IDLE_OFF_MS = 10 * 60_000
export const TEXT_LIMIT = 15_000
export const ELEMENT_LIMIT = 150
