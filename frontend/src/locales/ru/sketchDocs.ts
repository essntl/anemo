import type { Messages } from '@/lib/i18n'

/** Sketch documents around the canvas: making, opening, embedding, chat and transcription (features/sketch). */
const messages: Messages = {
  // Making one
  "New sketch": "Новый эскиз",
  "A drawing sheet, kept as a document: it can be moved, linked, embedded in a document and shown to the assistant.": "Лист для рисования, который хранится как документ: его можно перемещать, ссылаться на него, встраивать в документ и показывать ассистенту.",
  "e.g. Kitchen plan": "напр. План кухни",
  "Sheet": "Лист",
  "Endless sheet": "Бесконечный лист",
  "A4 pages": "Страницы A4",
  "One sheet that grows in every direction: for boards, maps and diagrams.": "Один лист, который растёт во все стороны: для досок, карт и схем.",
  "Pages one under the other: for notes by hand, to print or export.": "Страницы одна под другой: для рукописных заметок, печати или экспорта.",
  "Drawing sheet": "Лист для рисования",
  "new create document note write markdown": "новый создать документ заметка писать markdown",
  "new create sketch drawing draw whiteboard handwriting": "новый создать эскиз рисунок рисовать доска рукопись",

  // The open sketch
  "Offline: kept on this device": "Нет соединения: сохранено на этом устройстве",
  "This sketch was changed somewhere else while you were drawing.": "Этот эскиз изменили в другом месте, пока вы рисовали.",
  "The drawing has changes that could not be saved yet. Sort that out first.": "В рисунке есть изменения, которые ещё не удалось сохранить. Сначала разберитесь с этим.",
  "The drawing in this file can’t be read": "Рисунок в этом файле не удаётся прочитать",
  "It was probably changed outside the app. An earlier version in the history can be restored.": "Вероятно, его изменили вне приложения. Можно восстановить более раннюю версию из истории.",
  "Open the history": "Открыть историю",
  "This version has no drawing that can be read.": "В этой версии нет рисунка, который можно прочитать.",
  "About this sketch": "Об этом эскизе",
  "Text in the drawing": "Текст на рисунке",
  "Text in the drawing and details": "Текст на рисунке и подробности",
  "Show the text in the drawing and details": "Показать текст на рисунке и подробности",
  "Hide the text in the drawing and details": "Скрыть текст на рисунке и подробности",
  "Ask about this sketch": "Спросить об этом эскизе",
  "Copy link": "Копировать ссылку",
  "The link is copied. To show the drawing in a document, use Embed a sketch in its toolbar.": "Ссылка скопирована. Чтобы показать рисунок в документе, воспользуйтесь кнопкой «Встроить эскиз» на его панели инструментов.",
  "The browser didn't allow copying.": "Браузер не разрешил скопировать.",

  // Transcription
  "Transcribe": "Распознать текст",
  "Transcribe again": "Распознать ещё раз",
  "Reading the drawing…": "Читаю рисунок…",
  "The drawing could not be read. Try again, or with another model.": "Не удалось прочитать рисунок. Попробуйте ещё раз или с другой моделью.",
  "Read from the drawing by a model": "Прочитано с рисунка моделью",
  "Made from an earlier version of the drawing.": "Сделано по более ранней версии рисунка.",
  "A model that can see images can read the drawing: handwriting, labels, a diagram. The text then shows here, and search and agents can find the sketch by it.": "Модель, которая видит изображения, может прочитать рисунок: рукописный текст, подписи, схему. Тогда текст появится здесь, и поиск и агенты смогут найти эскиз по нему.",
  "This sketch’s drawing can’t be read.": "Рисунок этого эскиза не удаётся прочитать.",
  "The sketch keeps changing. Try again in a moment.": "Эскиз постоянно меняется. Попробуйте ещё раз через мгновение.",

  // Embedding and chat
  "Embedded sketch": "Встроенный эскиз",
  "Open sketch": "Открыть эскиз",
  "Embed a sketch": "Встроить эскиз",
  "Its image shows in the text and opens the sketch; it stays up to date as you draw.": "Его изображение появится в тексте и будет открывать эскиз; оно обновляется, когда вы рисуете.",
  "Sketch…": "Эскиз…",
  "A drawing from Documents, as an image": "Рисунок из документов, как изображение",
  "Attach a sketch": "Вложить эскиз",
  "Its image goes with the message, as it looks now.": "Его изображение будет отправлено с сообщением таким, как оно выглядит сейчас.",
  "Find a sketch by title": "Найти эскиз по названию",
  "No sketches yet. Make one in Documents with New sketch.": "Эскизов пока нет. Создайте его в документах кнопкой «Новый эскиз».",
}
export default messages
