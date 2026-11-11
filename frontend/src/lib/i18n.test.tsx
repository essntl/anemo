import { afterEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { dateLocale, plural, rich, setLocaleForTest, systemLocale, t } from './i18n'

afterEach(() => setLocaleForTest('en'))

describe('t', () => {
  it('is the English text itself in English, with places filled in', () => {
    expect(t('Signed in as {name}', { name: 'ada' })).toBe('Signed in as ada')
  })

  it('looks the text up in the dictionary of the language', () => {
    setLocaleForTest('uk', { 'Signed in as {name}': 'Ви ввійшли як {name}' })
    expect(t('Signed in as {name}', { name: 'ada' })).toBe('Ви ввійшли як ada')
  })

  it('falls back to English for a text the dictionary lacks', () => {
    setLocaleForTest('ru', {})
    expect(t('New chat')).toBe('New chat')
  })
})

describe('plural', () => {
  it('uses one and other in English', () => {
    expect(plural(1, '{n} file', '{n} files')).toBe('1 file')
    expect(plural(5, '{n} file', '{n} files')).toBe('5 files')
  })

  it('picks one, few or many in Ukrainian and Russian', () => {
    setLocaleForTest('uk', { '{n} file | {n} files': '{n} файл | {n} файли | {n} файлів' })
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, '{n} file', '{n} files'))).toEqual([
      '1 файл', '2 файли', '5 файлів', '11 файлів', '21 файл', '22 файли', '25 файлів',
    ])
  })

  it('fills in other places too', () => {
    setLocaleForTest('ru', { '{n} task in {where} | {n} tasks in {where}': '{n} задача в {where} | {n} задачи в {where} | {n} задач в {where}' })
    expect(plural(3, '{n} task in {where}', '{n} tasks in {where}', { where: 'X' })).toBe('3 задачи в X')
  })
})

describe('rich', () => {
  it('draws the tagged parts with the given elements, in the order of the translation', () => {
    setLocaleForTest('uk', { 'Read <b>this</b> first': 'Спершу <b>це</b> прочитайте' })
    const { container } = render(<p>{rich('Read <b>this</b> first', { b: (c) => <strong>{c}</strong> })}</p>)
    expect(container.innerHTML).toBe('<p>Спершу <strong>це</strong> прочитайте</p>')
  })
})

describe('systemLocale', () => {
  it('takes the first language of the browser that the app has', () => {
    expect(systemLocale(['de-DE', 'uk-UA', 'ru'])).toBe('uk')
    expect(systemLocale(['ru-RU'])).toBe('ru')
    expect(systemLocale(['fr'])).toBe('en')
  })
})

describe('dateLocale', () => {
  it('leaves English to the browser and names the other languages', () => {
    expect(dateLocale()).toBeUndefined()
    setLocaleForTest('uk')
    expect(dateLocale()).toBe('uk')
  })
})
