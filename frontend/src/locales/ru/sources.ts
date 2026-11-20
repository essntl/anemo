import type { Messages } from '@/lib/i18n'

/** Where things come from: who made them, and items synced from outside systems. */
const messages: Messages = {
  "Created by the assistant in a chat that was deleted.": "Создано ассистентом в чате, который удалён.",
  "Last changed by the assistant in a chat that was deleted.": "Последнее изменение: ассистент в чате, который удалён.",
  "Created by the assistant in <chat>{name}</chat>.": "Создано ассистентом в чате <chat>{name}</chat>.",
  "Last changed by the assistant in <chat>{name}</chat>.": "Последнее изменение: ассистент в чате <chat>{name}</chat>.",
  "Created by an automation that was deleted.": "Создано автоматизацией, которая удалена.",
  "Last changed by an automation that was deleted.": "Последнее изменение: автоматизация, которая удалена.",
  "Created by the automation <run>{name}</run>.": "Создано автоматизацией <run>{name}</run>.",
  "Last changed by the automation <run>{name}</run>.": "Последнее изменение: автоматизация <run>{name}</run>.",
  "Created outside Anemo.": "Создано вне Anemo.",
  "Last changed outside Anemo.": "Последнее изменение сделано вне Anemo.",
  "Created by you.": "Создано вами.",
  "Last changed by you.": "Последнее изменение: вы.",
  "Assistant in “{name}”": "Ассистент в «{name}»",
  "Assistant in a deleted chat": "Ассистент в удалённом чате",
  "Automation “{name}”": "Автоматизация «{name}»",
  "A deleted automation": "Удалённая автоматизация",
  "Synced": "Синхронизировано",
  "Synced from {source}": "Синхронизировано из {source}",
  "Synced from an outside system": "Синхронизировано из внешней системы",
  "{title} – open the original": "{title} – открыть оригинал",
  "Detach from its source?": "Отсоединить от источника?",
  "It becomes an ordinary item. The next sync may add the original again as a new item.": "Это станет обычной записью. Следующая синхронизация может снова добавить оригинал как новую запись.",
  "Detach": "Отсоединить",
  "Where it comes from": "Откуда это",
  "Last synced {when}": "Последняя синхронизация: {when}",
  "You changed it by hand {when}": "Вы изменили это вручную: {when}",
  "Detach from source": "Отсоединить от источника",
}

export default messages
