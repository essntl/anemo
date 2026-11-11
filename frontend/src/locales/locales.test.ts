import { describe, expect, it } from 'vitest'
import type { Messages } from '@/lib/i18n'
import { keysIn } from './scan'
import ru from './ru'
import uk from './uk'

// Every source file of the app, as text.
const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../locales/**', '!../api/schema.d.ts', '!../lib/i18n.tsx'], {
  eager: true,
  query: '?raw',
  import: 'default',
})

const used = new Map<string, string>()
for (const [file, source] of Object.entries(sources)) {
  for (const key of keysIn(source)) if (!used.has(key)) used.set(key, file.replace('../', ''))
}

// Each dictionary file on its own, to see where two of them disagree.
const files = {
  uk: import.meta.glob<Messages>(['./uk/*.ts', '!./uk/index.ts'], { eager: true, import: 'default' }),
  ru: import.meta.glob<Messages>(['./ru/*.ts', '!./ru/index.ts'], { eager: true, import: 'default' }),
}

const places = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
const tags = (text: string) => [...text.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort().join(',')

describe('keysIn', () => {
  it('finds the texts of t, msg, rich and plural', () => {
    const source = `t('One'); msg("Two {n}"); rich(\`Three\`, {}); plural(count, '{n} file', '{n} files'); t('It\\'s'); format(x); alert('no')`
    expect(keysIn(source)).toEqual(['One', 'Two {n}', 'Three', "It's", '{n} file | {n} files'])
  })
})

describe.each([['uk', uk], ['ru', ru]] as const)('the %s dictionary', (name, messages) => {
  it('translates a text the same way in every file', () => {
    const first = new Map<string, { value: string; file: string }>()
    const disagree: string[] = []
    for (const [file, part] of Object.entries(files[name])) {
      for (const [key, value] of Object.entries(part)) {
        const seen = first.get(key)
        if (!seen) first.set(key, { value, file })
        else if (seen.value !== value) disagree.push(`${JSON.stringify(key)}: ${seen.file} says ${JSON.stringify(seen.value)}, ${file} says ${JSON.stringify(value)}`)
      }
    }
    expect(disagree).toEqual([])
  })

  it('translates every text the app shows', () => {
    const missing = [...used].filter(([key]) => !(key in messages)).map(([key, file]) => `${file}: ${JSON.stringify(key)}`)
    expect(missing).toEqual([])
  })

  it('keeps the {places} and <tags> of the English text', () => {
    const wrong: string[] = []
    for (const [key, value] of Object.entries(messages)) {
      const isPlural = key.includes(' | ')
      // Each form of a plural stands alone; all of them may use {n} and the same places.
      const forms = isPlural ? value.split(' | ') : [value]
      if (isPlural && forms.length !== 3) wrong.push(`${JSON.stringify(key)}: needs three forms (one | few | many)`)
      const wanted = new Set(places(key).split(',').filter(Boolean))
      for (const form of forms) {
        for (const place of places(form).split(',').filter(Boolean)) {
          if (!wanted.has(place) && place !== 'n') wrong.push(`${JSON.stringify(key)}: unknown {${place}}`)
        }
      }
      if (!isPlural && places(key) !== places(value)) wrong.push(`${JSON.stringify(key)}: {places} differ`)
      if (tags(key) !== tags(value)) wrong.push(`${JSON.stringify(key)}: <tags> differ`)
    }
    expect(wrong).toEqual([])
  })

  it('has no translation that is left empty', () => {
    expect(Object.entries(messages).filter(([, value]) => value.trim() === '').map(([key]) => key)).toEqual([])
  })
})
