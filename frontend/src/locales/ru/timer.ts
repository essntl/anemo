import type { Messages } from '@/lib/i18n'

/** The response timer: how long an answer and its tool calls take. */
const messages: Messages = {
  "{m} m {s} s": "{m} мин {s} с",
  "{h} h {m} m": "{h} ч {m} мин",
  "waiting for you": "ждёт вас",
  "paused": "на паузе",
  "Stopped after {duration}": "Остановлено через {duration}",
  "Failed after {duration}": "Ошибка через {duration}",
  "How long the answer took:": "Сколько длился ответ:",
  "running since {time}": "идёт с {time}",
  "Time this answer has taken": "Сколько длится этот ответ",
  "Time to first text": "До первого текста",
  "The time spent waiting for you is not part of the total.": "Время, когда ответ ждал вас, в общее не входит.",
}

export default messages
