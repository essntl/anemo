import { LANGUAGES } from '@/shared/languages'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Select } from '../ui/Select'
import { usePreferences } from '../state/preferences'

/** The default target language for Translate (right-click) and for explanations. */
export function TranslateCard() {
  const { prefs, update } = usePreferences()
  return (
    <Card>
      <CardHeader title="Translate & explain" description="Right-click a selection: Anemo Companion ▸ Explain, or ▸ Translate. Uses your Inline & formatting model in Anemo; nothing personal is sent." />
      <CardBody className="flex flex-col gap-1.5">
        <label htmlFor="target-language" className="text-[12.5px] font-medium">Translate into, and explain in</label>
        <Select
          id="target-language"
          value={prefs.targetLanguage}
          onValueChange={(v) => void update((p) => ({ ...p, targetLanguage: v }))}
          options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
        />
        <p className="text-[12px] text-muted">The Translate menu also lists the other languages, for one-off choices.</p>
      </CardBody>
    </Card>
  )
}
