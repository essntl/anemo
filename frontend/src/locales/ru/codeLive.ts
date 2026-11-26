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
  "A queued message couldn’t be sent: it is back in its thread’s box.": "Сообщение из очереди не удалось отправить: оно снова в поле ввода своей цепочки.",
  "Delivered {when}": "Доставлено {when}",
  "This message wasn’t sent.": "Это сообщение не отправлено.",
  "Sending…": "Отправка…",
  "Sending now: Claude Code stops its current step…": "Отправляется сейчас: Claude Code останавливает текущий шаг…",
  "Queued: Claude Code takes it in after its current step": "В очереди: Claude Code прочитает его после текущего шага",
  "Queued: sent after Claude Code’s current step": "В очереди: будет отправлено после текущего шага Claude Code",
  "Send it as a follow-up now": "Отправить как продолжение сейчас",
  "Stop Claude Code’s current step and send this now": "Остановить текущий шаг Claude Code и отправить это сейчас",
  "Message for this job": "Сообщение для этого запуска",
  "Queue a message for this job…": "Поставить сообщение в очередь этого запуска…",
  "Send now: stop Claude Code’s current step and send this at once": "Отправить сейчас: остановить текущий шаг Claude Code и сразу отправить это",
  "Queue: Claude Code takes it in after its current step": "В очередь: Claude Code прочитает его после текущего шага",
}

export default messages
