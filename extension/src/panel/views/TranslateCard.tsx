import { LANGUAGES } from '@/shared/languages'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { usePreferences } from '../state/preferences'

/** The default target language for Translate (right-click) and for explanations. */
export function TranslateCard() {
  const { prefs, update } = usePreferences()
  return (
    <Card>
      <CardHeader title="Translate & explain" description="Right-click a selection: Anemo Companion ▸ Explain, or ▸ Translate. Uses your Inline & formatting model in Anemo; nothing personal is sent." />
      <CardBody className="flex flex-col gap-1.5">
        <label htmlFor="target-language" className="text-[12.5px] font-medium">Translate into, and explain in</label>
        <select
          id="target-language"
          className="h-9 w-full rounded-control border border-border bg-surface px-2 text-[13px]"
          value={prefs.targetLanguage}
          onChange={(e) => void update((p) => ({ ...p, targetLanguage: e.target.value }))}
        >
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <p className="text-[12px] text-muted">The Translate menu also lists the other languages, for one-off choices.</p>
      </CardBody>
    </Card>
  )
}
