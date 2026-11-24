import { useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { type AllSettings, useSaveSection, useSettings } from '@/features/settings/api'
import { dateLocale, rich, t } from '@/lib/i18n'
import { canRecord } from './recorder'
import { parseVocabulary } from './vocabulary'

type DictationSettings = AllSettings['dictation']

/** Languages the speech-to-text models know well; the names come from the browser, in the app's language. */
const LANGUAGES = ['en', 'uk', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'sv', 'nb', 'da', 'fi', 'cs', 'tr', 'ar', 'ja', 'zh', 'ko']

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(dateLocale() ? [dateLocale()!] : undefined, { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function VocabularyField({ value, onSave, saving }: { value: string[]; onSave: (words: string[]) => void; saving: boolean }) {
  const [text, setText] = useState(value.join('\n'))
  const dirty = JSON.stringify(parseVocabulary(text)) !== JSON.stringify(value)
  return (
    <div className="flex flex-col gap-2 py-3">
      <Field label={t('Words to spell right')}
        hint={t('Names, projects and terms, one per line. Both models get them, so “Anemo” doesn’t come out as “anemone”.')}>
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('e.g. Anemo\nKubernetes\nAstrid Lindqvist')} />
      </Field>
      <div>
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => onSave(parseVocabulary(text))}>{t('Save words')}</Button>
      </div>
    </div>
  )
}

/** Settings → Dictation. */
export function DictationSettingsPage() {
  const settings = useSettings()
  const save = useSaveSection('dictation')
  const d = settings.data?.dictation
  if (!d) return null
  const update = (patch: Partial<DictationSettings>) => save.mutate({ ...d, ...patch })

  return (
    <div className="flex flex-col gap-(--card-gap)">
      <Card>
        <CardHeader title={t('Dictation')}
          description={t('Speak instead of typing: press Caps Lock twice, or the microphone in the message box. What you say is written down and tidied up, then put where you were typing.')} />
        <CardBody className="flex flex-col divide-y divide-border py-2">
          {!canRecord() && (
            <p className="py-3 text-[13px] text-warning">
              {t('This page can’t use the microphone. Browsers allow it only over https (or on localhost).')}
            </p>
          )}
          <label className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="block text-[13.5px] font-medium">{t('Tidy up the text')}</span>
              <span className="block text-[12px] text-muted">{t('Takes out “um”s, false starts and repeats, applies your corrections, and turns a request with several parts into a list. Off: the text as it was heard.')}</span>
            </span>
            <Switch label={t('Tidy up the text')} checked={d.clean_up} onChange={(v) => update({ clean_up: v })} />
          </label>
          <label className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="block text-[13.5px] font-medium">{t('Caps Lock twice to dictate')}</span>
              <span className="block text-[12px] text-muted">{t('Anywhere in Anemo, also while you type. Press twice again to finish, Esc to cancel. Two presses leave Caps Lock as it was.')}</span>
            </span>
            <Switch label={t('Caps Lock twice to dictate')} checked={d.caps_lock} onChange={(v) => update({ caps_lock: v })} />
          </label>
          <div className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="block text-[13.5px] font-medium">{t('Language')}</span>
              <span className="block text-[12px] text-muted">{t('Automatic works for most. Choosing one helps with short recordings.')}</span>
            </span>
            <Select aria-label={t('Language')} className="w-48" value={d.language}
              onValueChange={(v) => update({ language: v })}
              options={[{ value: '', label: t('Automatic') }, ...LANGUAGES.map((code) => ({ value: code, label: languageName(code) }))]} />
          </div>
          <VocabularyField key={(d.vocabulary ?? []).join('\n')} value={d.vocabulary ?? []} saving={save.isPending} onSave={(vocabulary) => update({ vocabulary })} />
          {save.isError && <p className="py-2 text-[13px] text-error">{errorMessage(save.error)}</p>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('Models')} />
        <CardBody>
          <p className="text-[13px] text-muted">
            {rich('Dictation uses two models, chosen in <link>Providers & Models</link>: one for <b>Transcription</b> (speech to text: OpenAI’s gpt-4o-transcribe or whisper-1, or a Whisper model on an OpenAI-compatible server such as Groq or your own) and one for <b>Dictation clean-up</b> (a fast chat model; unset, the chat model). Neither the recording nor the text is kept.', {
              link: (children) => <Link to="/settings/providers" className="text-accent hover:underline">{children}</Link>,
              b: (children) => <span className="font-medium text-text">{children}</span>,
            })}
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
