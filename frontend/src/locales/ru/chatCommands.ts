import type { Messages } from '@/lib/i18n'

/** The chat's slash commands (/model, /rename, …) and what they say when done. */
const messages: Messages = {
  "Choose the model for this chat": "Выбрать модель для этого чата",
  "How hard the model thinks": "Насколько тщательно модель рассуждает",
  "Chat or Agent": "Чат или агент",
  "The agent profile, with its permissions": "Профиль агента с его разрешениями",
  "A new chat in the same project, with the same model and mode": "Новый чат в том же проекте, с той же моделью и режимом",
  "Move this chat to a project": "Переместить этот чат в проект",
  "Give this chat a title": "Дать этому чату название",
  "Continue in a copy of this chat": "Продолжить в копии этого чата",
  "Answer the last message again": "Ответить на последнее сообщение ещё раз",
  "Summarize the chat so far, keeping what you name in detail": "Подытожить чат до сих пор, сохранив подробно то, что вы назовёте",
  "what to keep": "что сохранить",
  "Dictate the message": "Надиктовать сообщение",
  "Every command and skill": "Все команды и навыки",
  "Commands and skills": "Команды и навыки",
  "Commands": "Команды",
  "re-reads this chat": "перечитывает этот чат",
  "Nothing matches “{query}”.": "Ничего не соответствует «{query}».",
  "default": "по умолчанию",
  "Model: {name}": "Модель: {name}",
  "Chat mode": "Режим чата",
  "Profile: {name}": "Профиль: {name}",
  "Moved to {project}": "Перемещено в {project}",
  "Branched": "Ответвлено",
}
export default messages
