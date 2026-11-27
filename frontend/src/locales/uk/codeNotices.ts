import type { Messages } from '@/lib/i18n'

/** The Code page: what Claude Code itself puts into a job, and the usage popup. */
const messages: Messages = {
  "reset at {when}": "скинуто о {when}",
  "reset time not known": "час скидання невідомий",
  "Claude subscription usage": "Використання підписки Claude",
  "Measured {ago} ({when}), when a job last reported it.": "Виміряно {ago} ({when}), коли завдання востаннє про це повідомило.",
  "A background task ended: {status}": "Фонове завдання завершилося: {status}",
  "A background task ended": "Фонове завдання завершилося",
}
export default messages
