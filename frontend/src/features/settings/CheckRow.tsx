import { AlertTriangle, CheckCircle2, CircleSlash } from 'lucide-react'
import type { Schemas } from '@/api/client'

type Check = Schemas['Check']

/** One line of Settings > Advanced's system status (also in the first-run setup). */
export function CheckRow({ check }: { check: Check }) {
  // An optional part that is off is not a problem, just a fact.
  const Icon = check.ok ? CheckCircle2 : check.optional ? CircleSlash : AlertTriangle
  const tone = check.ok ? 'text-success' : check.optional ? 'text-subtle' : 'text-error'
  return (
    <li className="flex items-start gap-3 border-t border-border py-2.5 first:border-t-0">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{check.name}</div>
        <div className={`break-words text-[12.5px] ${check.ok || check.optional ? 'text-muted' : 'text-error'}`}>{check.detail}</div>
      </div>
    </li>
  )
}
