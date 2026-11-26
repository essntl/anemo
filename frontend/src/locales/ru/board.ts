import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "{column}, position {position} of {count}": "{column}, позиция {position} из {count}",
  "Picked up {title}. The arrow keys move it, Space puts it down, Escape puts it back.": "Взята «{title}». Стрелки перемещают карточку, пробел кладёт её, Escape возвращает на место.",
  "{title} moved to {place}.": "«{title}» перемещена: {place}.",
  "{title} put down where it was.": "«{title}» осталась на своём месте.",
  "{title} put back.": "«{title}» возвращена на место.",
  "movable card": "перемещаемая карточка",
  "Space picks the card up; then the arrow keys move it, Space puts it down and Escape puts it back.": "Пробел берёт карточку; затем стрелки перемещают её, пробел кладёт, а Escape возвращает на место.",
  "Tasks by status": "Задачи по статусу",
  "Project: {name}": "Проект: {name}",
}
export default messages
