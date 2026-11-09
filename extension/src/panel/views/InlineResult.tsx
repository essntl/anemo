import { Copy, X } from 'lucide-react'
import { storage } from '@/shared/storage'
import { Markdown } from '../chat/Markdown'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'

/** An explanation or translation for a page that can't show a box (Chrome's PDF viewer). */
export function InlineResult() {
  const { connection } = useSession()
  const result = useStored('session', 'panelInline').value
  if (!result) return null
  const close = () => void storage.set('session', 'panelInline', null)
  return (
    <div className="px-3 pt-3" data-testid="inline-result">
      <Card>
        <CardHeader
          title={result.mode === 'explain' ? 'Explanation' : 'Translation'}
          actions={<Button size="icon" variant="ghost" aria-label="Close" onClick={close} icon={<X className="h-4 w-4" />} />}
        />
        <CardBody className="flex flex-col gap-2 pt-2">
          <blockquote className="line-clamp-3 border-l-2 border-border-strong pl-2 text-[12px] text-muted">{result.selection}</blockquote>
          {result.status === 'error' ? (
            <p className="text-[12.5px] text-error">{result.error}</p>
          ) : result.text ? (
            result.mode === 'explain' ? <Markdown text={result.text} serverUrl={connection.serverUrl} /> : <p className="whitespace-pre-wrap text-[13px]">{result.text}</p>
          ) : (
            <p className="text-[12.5px] text-muted">Working…</p>
          )}
          {result.status === 'done' && (
            <div>
              <Button size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void navigator.clipboard.writeText(result.text)}>Copy</Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
