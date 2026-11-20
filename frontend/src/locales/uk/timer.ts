import type { Messages } from '@/lib/i18n'

/** The response timer: how long an answer and its tool calls take. */
const messages: Messages = {
  "{m} m {s} s": "{m} хв {s} с",
  "{h} h {m} m": "{h} год {m} хв",
  "waiting for you": "чекає на вас",
  "paused": "на паузі",
  "Stopped after {duration}": "Зупинено через {duration}",
  "Failed after {duration}": "Помилка через {duration}",
  "How long the answer took: {duration}": "Скільки тривала відповідь: {duration}",
  "Time this answer has taken": "Скільки триває ця відповідь",
  "Time to first text": "До першого тексту",
  "The time spent waiting for you is not part of the total.": "Час, коли відповідь чекала на вас, до загального не входить.",
}

export default messages
