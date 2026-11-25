import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "{column}, position {position} of {count}": "{column}, позиція {position} з {count}",
  "Picked up {title}. The arrow keys move it, Space puts it down, Escape puts it back.": "Взято «{title}». Стрілки переміщують картку, пробіл кладе її, Escape повертає на місце.",
  "{title} moved to {place}.": "«{title}» переміщено: {place}.",
  "{title} put down where it was.": "«{title}» лишилася на своєму місці.",
  "{title} put back.": "«{title}» повернуто на місце.",
  "movable card": "картка, яку можна перемістити",
  "Space picks the card up; then the arrow keys move it, Space puts it down and Escape puts it back.": "Пробіл бере картку; потім стрілки переміщують її, пробіл кладе, а Escape повертає на місце.",
  "Tasks by status": "Завдання за статусом",
  "Project: {name}": "Проєкт: {name}",
}
export default messages
