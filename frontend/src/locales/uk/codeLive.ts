import type { Messages } from '@/lib/i18n'

/** Code: the usage indicator, messages for a running job and auto continue (features/code, code-sessions.md §14–16). */
const messages: Messages = {
  "5-hour": "5 годин",
  "Weekly": "Тиждень",
  "Weekly (Opus)": "Тиждень (Opus)",
  "Weekly (Sonnet)": "Тиждень (Sonnet)",
  "{window}: reset at {when}": "{window}: скинуто о {when}",
  "{window}: {used} used, resets {when}": "{window}: використано {used}, скидається {when}",
  "{window}: {used} used": "{window}: використано {used}",
  "has reset": "скинуто",
  "resets {when}": "скидається {when}",
  "as of {when}": "станом на {when}",
  "Claude subscription usage as of {when}": "Використання підписки Claude станом на {when}",
  "Tokens": "Токени",
  "{input} input ({cached} read from the cache, {written} written to it) · {output} output": "{input} на вході ({cached} прочитано з кешу, {written} записано в нього) · {output} на виході",
}

export default messages
