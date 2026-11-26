import type { Messages } from '@/lib/i18n'

/** Code: the usage indicator, messages for a running job and auto continue (features/code, code-sessions.md §14–16). */
const messages: Messages = {
  "5-hour": "5 часов",
  "Weekly": "Неделя",
  "Weekly (Opus)": "Неделя (Opus)",
  "Weekly (Sonnet)": "Неделя (Sonnet)",
  "{window}: reset at {when}": "{window}: сброшено в {when}",
  "{window}: {used} used, resets {when}": "{window}: использовано {used}, сброс {when}",
  "{window}: {used} used": "{window}: использовано {used}",
  "has reset": "сброшено",
  "resets {when}": "сброс {when}",
  "as of {when}": "на {when}",
  "Claude subscription usage as of {when}": "Использование подписки Claude на {when}",
  "Tokens": "Токены",
  "{input} input ({cached} read from the cache, {written} written to it) · {output} output": "{input} на входе ({cached} прочитано из кэша, {written} записано в него) · {output} на выходе",
}

export default messages
