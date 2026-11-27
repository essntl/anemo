import type { Messages } from '@/lib/i18n'

/** The Code page: what Claude Code itself puts into a job, and the usage popup. */
const messages: Messages = {
  "reset at {when}": "сброшено в {when}",
  "reset time not known": "время сброса неизвестно",
  "Claude subscription usage": "Использование подписки Claude",
  "Measured {ago} ({when}), when a job last reported it.": "Измерено {ago} ({when}), когда задание последний раз сообщило об этом.",
  "A background task ended: {status}": "Фоновая задача завершилась: {status}",
  "A background task ended": "Фоновая задача завершилась",
}
export default messages
