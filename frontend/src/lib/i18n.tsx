/**
 * The app's language. English is the source: the English text is the key, so
 * `t('New chat')` shows "New chat" in English and looks the same text up in the
 * dictionary of another language (src/locales/<language>/*.ts).
 *
 *   t('Sign out (signed in as {name})', { name })
 *   plural(count, '{n} file', '{n} files')          // {n} is the count
 *   rich('Read <b>this</b> first', { b: (c) => <strong>{c}</strong> })
 *   const TABS = [{ id: 'all', label: msg('All') }]  // outside a component: translate with t(tab.label) when shown
 *
 * `t` reads the language when it is called, so call it while rendering (or in a
 * handler), never at the top of a module. Changing the language draws the whole app
 * again (main.tsx), so components need no hook for it.
 *
 * The first argument must be a plain string literal: src/locales/locales.test.ts reads
 * the source for them and fails when a language has no translation for one.
 */
import { Fragment, type ReactNode } from 'react'
import { create } from 'zustand'

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'uk', name: 'Українська' },
  { code: 'ru', name: 'Русский' },
] as const
export type Locale = (typeof LANGUAGES)[number]['code']
/** What is chosen in Settings: one language, or whatever the browser asks for. */
export type LanguageChoice = Locale | 'system'
export type Messages = Record<string, string>

const STORAGE_KEY = 'anemo.language'
const isLocale = (value: unknown): value is Locale => LANGUAGES.some((l) => l.code === value)

/** The first of the browser's languages that the app has; English otherwise. */
export function systemLocale(languages: readonly string[] = navigator.languages ?? [navigator.language]): Locale {
  for (const tag of languages) {
    const code = tag.toLowerCase().split('-')[0]
    if (isLocale(code)) return code
  }
  return 'en'
}

export const resolveLocale = (choice: LanguageChoice): Locale => (choice === 'system' ? systemLocale() : choice)

/** The choice this browser remembers (so the right language shows before the settings load, and on the login page). */
export function storedChoice(): LanguageChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'system' || isLocale(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

type Loaders = Record<Exclude<Locale, 'en'>, () => Promise<{ default: Messages }>>
let loaders: Partial<Loaders> = {}

/**
 * Says where the dictionaries are (main.tsx does, once). They are not imported here:
 * the dictionaries use this module's types, and that would be a circle.
 */
export function registerLanguages(all: Loaders): void {
  loaders = all
}

interface LocaleState {
  choice: LanguageChoice
  locale: Locale
  messages: Messages
}

export const useLocaleStore = create<LocaleState>(() => ({ choice: 'system', locale: 'en', messages: {} }))

/**
 * Switch the language: loads its dictionary, then the app draws again. Remembered in
 * this browser; Settings > General also saves it with the other settings.
 */
export async function setLanguage(choice: LanguageChoice): Promise<void> {
  const locale = resolveLocale(choice)
  let messages: Messages = {}
  if (locale !== 'en') {
    try {
      messages = (await loaders[locale]?.())?.default ?? {}
    } catch {
      // The dictionary could not be fetched (offline): the app stays readable in English.
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Private mode: the choice lasts until the page is closed.
  }
  document.documentElement.lang = locale
  useLocaleStore.setState({ choice, locale, messages })
}

/** For tests: a language with the given dictionary, without loading anything. */
export function setLocaleForTest(locale: Locale, messages: Messages = {}): void {
  useLocaleStore.setState({ choice: locale, locale, messages })
}

export const currentLocale = (): Locale => useLocaleStore.getState().locale

/**
 * The language for `toLocaleDateString`, `Intl.DateTimeFormat` and the like. English
 * keeps the browser's own formats (`undefined`), as before there were languages.
 */
export function dateLocale(): string | undefined {
  const locale = currentLocale()
  return locale === 'en' ? undefined : locale
}

type Vars = Record<string, string | number>

function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** The text in the current language, with `{name}` places filled in. */
export function t(text: string, vars?: Vars): string {
  return fill(useLocaleStore.getState().messages[text] ?? text, vars)
}

/** Marks a text for translation where `t` cannot be called yet (a constant of a module). Show it with `t(...)`. */
export const msg = (text: string): string => text

/** The dictionary key of a `plural(...)` call. */
export const pluralKey = (one: string, other: string): string => `${one} | ${other}`

/**
 * A text that depends on a count. In English: `one` for 1, `other` otherwise. A
 * dictionary gives the forms of its language, separated by " | ", in the order
 * one, few, many (Ukrainian and Russian: "{n} файл | {n} файли | {n} файлів").
 * `{n}` is the count.
 */
export function plural(count: number, one: string, other: string, vars?: Vars): string {
  const { locale, messages } = useLocaleStore.getState()
  const all = { n: count, ...vars }
  const translated = locale === 'en' ? undefined : messages[pluralKey(one, other)]
  if (translated === undefined) return fill(count === 1 ? one : other, all)
  const forms = translated.split(' | ')
  const category = new Intl.PluralRules(locale).select(count)
  const index = category === 'one' ? 0 : category === 'few' ? 1 : 2
  return fill(forms[Math.min(index, forms.length - 1)], all)
}

/**
 * A text with parts that are elements: `<name>…</name>` in the text is drawn by
 * `parts.name`. Tags do not nest.
 *
 *   rich('See <a>the docs</a>.', { a: (c) => <a href="/docs">{c}</a> })
 */
export function rich(text: string, parts: Record<string, (children: string) => ReactNode>, vars?: Vars): ReactNode {
  const translated = t(text, vars)
  const out: ReactNode[] = []
  const tag = /<(\w+)>(.*?)<\/\1>/gs
  let last = 0
  for (const match of translated.matchAll(tag)) {
    if (match.index > last) out.push(translated.slice(last, match.index))
    const draw = parts[match[1]]
    out.push(<Fragment key={match.index}>{draw ? draw(match[2]) : match[2]}</Fragment>)
    last = match.index + match[0].length
  }
  if (last < translated.length) out.push(translated.slice(last))
  return out.length === 1 ? out[0] : <>{out}</>
}
