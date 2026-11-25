import type { Messages } from '@/lib/i18n'

/** Sketch documents around the canvas: making, opening, embedding, chat and transcription (features/sketch). */
const messages: Messages = {
  // Making one
  "New sketch": "Новий ескіз",
  "A drawing sheet, kept as a document: it can be moved, linked, embedded in a document and shown to the assistant.": "Аркуш для малювання, що зберігається як документ: його можна переміщати, давати на нього посилання, вбудовувати в документ і показувати асистентові.",
  "e.g. Kitchen plan": "напр. План кухні",
  "Sheet": "Аркуш",
  "Endless sheet": "Нескінченний аркуш",
  "A4 pages": "Сторінки A4",
  "One sheet that grows in every direction: for boards, maps and diagrams.": "Один аркуш, що росте в усі боки: для дошок, мап і схем.",
  "Pages one under the other: for notes by hand, to print or export.": "Сторінки одна під одною: для рукописних нотаток, друку чи експорту.",
  "Drawing sheet": "Аркуш для малювання",
  "new create document note write markdown": "новий створити документ нотатка писати markdown",
  "new create sketch drawing draw whiteboard handwriting": "новий створити ескіз малюнок малювати дошка рукопис",

  // The open sketch
  "Offline: kept on this device": "Немає з’єднання: збережено на цьому пристрої",
  "This sketch was changed somewhere else while you were drawing.": "Цей ескіз змінили в іншому місці, поки ви малювали.",
  "The drawing has changes that could not be saved yet. Sort that out first.": "У малюнку є зміни, які ще не вдалося зберегти. Спершу розберіться з цим.",
  "The drawing in this file can’t be read": "Малюнок у цьому файлі не вдається прочитати",
  "It was probably changed outside the app. An earlier version in the history can be restored.": "Імовірно, його змінили поза застосунком. Можна відновити попередню версію з історії.",
  "Open the history": "Відкрити історію",
  "This version has no drawing that can be read.": "У цій версії немає малюнка, який можна прочитати.",
  "About this sketch": "Про цей ескіз",
  "Text in the drawing": "Текст на малюнку",
  "Text in the drawing and details": "Текст на малюнку й подробиці",
  "Show the text in the drawing and details": "Показати текст на малюнку й подробиці",
  "Hide the text in the drawing and details": "Сховати текст на малюнку й подробиці",
  "Ask about this sketch": "Запитати про цей ескіз",
  "Copy link": "Копіювати посилання",
  "The link is copied. To show the drawing in a document, use Embed a sketch in its toolbar.": "Посилання скопійовано. Щоб показати малюнок у документі, скористайтеся кнопкою «Вбудувати ескіз» на його панелі інструментів.",
  "The browser didn't allow copying.": "Браузер не дозволив скопіювати.",

  // Transcription
  "Transcribe": "Розпізнати текст",
  "Transcribe again": "Розпізнати ще раз",
  "Reading the drawing…": "Читаю малюнок…",
  "The drawing could not be read. Try again, or with another model.": "Не вдалося прочитати малюнок. Спробуйте ще раз або з іншою моделлю.",
  "Read from the drawing by a model": "Прочитано з малюнка моделлю",
  "Made from an earlier version of the drawing.": "Зроблено з попередньої версії малюнка.",
  "A model that can see images can read the drawing: handwriting, labels, a diagram. The text then shows here, and search and agents can find the sketch by it.": "Модель, яка бачить зображення, може прочитати малюнок: рукописний текст, підписи, схему. Тоді текст з’явиться тут, і пошук та агенти зможуть знайти ескіз за ним.",
  "This sketch’s drawing can’t be read.": "Малюнок цього ескізу не вдається прочитати.",
  "The sketch keeps changing. Try again in a moment.": "Ескіз постійно змінюється. Спробуйте ще раз за мить.",

  // Embedding and chat
  "Embedded sketch": "Вбудований ескіз",
  "Open sketch": "Відкрити ескіз",
  "Embed a sketch": "Вбудувати ескіз",
  "Its image shows in the text and opens the sketch; it stays up to date as you draw.": "Його зображення з’явиться в тексті й відкриватиме ескіз; воно оновлюється, коли ви малюєте.",
  "Sketch…": "Ескіз…",
  "A drawing from Documents, as an image": "Малюнок із документів, як зображення",
  "Attach a sketch": "Вкласти ескіз",
  "Its image goes with the message, as it looks now.": "Його зображення буде надіслано з повідомленням таким, як воно є зараз.",
  "Find a sketch by title": "Знайти ескіз за назвою",
  "No sketches yet. Make one in Documents with New sketch.": "Ескізів ще немає. Створіть його в документах кнопкою «Новий ескіз».",
}
export default messages
