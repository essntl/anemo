import type { Messages } from '@/lib/i18n'

/** The chat's slash commands (/model, /rename, …) and what they say when done. */
const messages: Messages = {
  "Choose the model for this chat": "Вибрати модель для цього чату",
  "How hard the model thinks": "Наскільки ретельно модель міркує",
  "Chat or Agent": "Чат або агент",
  "The agent profile, with its permissions": "Профіль агента з його дозволами",
  "A new chat in the same project, with the same model and mode": "Новий чат у тому самому проєкті, з тією самою моделлю й режимом",
  "Move this chat to a project": "Перемістити цей чат до проєкту",
  "Give this chat a title": "Дати цьому чату назву",
  "Continue in a copy of this chat": "Продовжити в копії цього чату",
  "Answer the last message again": "Відповісти на останнє повідомлення ще раз",
  "Summarize the chat so far, keeping what you name in detail": "Підсумувати чат дотепер, зберігши докладно те, що ви назвете",
  "what to keep": "що зберегти",
  "Dictate the message": "Надиктувати повідомлення",
  "Every command and skill": "Усі команди й навички",
  "Commands and skills": "Команди й навички",
  "Commands": "Команди",
  "re-reads this chat": "перечитує цей чат",
  "Nothing matches “{query}”.": "Ніщо не відповідає «{query}».",
  "default": "типова",
  "Model: {name}": "Модель: {name}",
  "Chat mode": "Режим чату",
  "Profile: {name}": "Профіль: {name}",
  "Moved to {project}": "Переміщено до {project}",
  "Branched": "Відгалужено",
}
export default messages
