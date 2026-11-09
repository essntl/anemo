/** "Always allow on example.com": shown where the panel just read a tab thanks to a click,
 *  so that site works from the panel without the click next time (question 48, a1). */
import { useEffect, useState } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { originPattern, siteName } from '@/shared/sites'

export function AlwaysAllow({ url }: { url: string | undefined }) {
  const pattern = originPattern(url)
  const [allowed, setAllowed] = useState<{ pattern: string; value: boolean } | null>(null)
  const [justAllowed, setJustAllowed] = useState(false)

  useEffect(() => {
    if (!pattern) return
    let gone = false
    void chrome.permissions.contains({ origins: [pattern] }).then((value) => {
      if (!gone) setAllowed({ pattern, value })
    })
    return () => {
      gone = true
    }
  }, [pattern])

  if (!pattern || !allowed || allowed.pattern !== pattern) return null
  if (justAllowed) {
    return (
      <p className="flex items-center gap-1 text-[11.5px] text-muted">
        <Check className="h-3 w-3" /> Anemo can now read {siteName(pattern)} from the panel.
      </p>
    )
  }
  if (allowed.value) return null
  const allow = async () => {
    // Straight from the click: Chrome asks only during a user action.
    const ok = await chrome.permissions.request({ origins: [pattern] }).catch(() => false)
    if (ok) setJustAllowed(true)
  }
  return (
    <button type="button" className="flex w-fit items-center gap-1 text-[11.5px] text-accent hover:underline" onClick={() => void allow()}>
      <ShieldCheck className="h-3 w-3" /> Always allow on {siteName(pattern)}
    </button>
  )
}
