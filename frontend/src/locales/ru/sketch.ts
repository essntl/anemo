import type { Messages } from '@/lib/i18n'

/** The drawing canvas of sketch documents (features/sketch/canvas). */
const messages: Messages = {
  "Sketch": "Эскиз",
  "drawing canvas": "холст для рисования",
  "Drawing in a sketch": "Рисование в эскизе",

  // Tools
  "Drawing tools": "Инструменты рисования",
  "Pen": "Ручка",
  "Highlighter": "Текстовыделитель",
  "Eraser": "Ластик",
  "Select": "Выделить",
  "Shapes": "Фигуры",
  "Line": "Линия",
  "Arrow": "Стрелка",
  "Rectangle": "Прямоугольник",
  "Ellipse": "Эллипс",
  "Move around": "Перемещать лист",
  "Hold Shift for a square, a circle or a line at 45°.": "Удерживайте Shift, чтобы получить квадрат, круг или линию под углом 45°.",
  "Delete what is selected": "Удалить выделенное",
  "Clear the selection": "Снять выделение",
  "Drag to move around the sheet": "Тяните, чтобы перемещаться по листу",

  // Colour and size
  "Colour and size": "Цвет и размер",
  "Your own colour": "Свой цвет",
  "Ink": "Чернила",
  "Red": "Красный",
  "Yellow": "Жёлтый",
  "Purple": "Фиолетовый",
  "Grey": "Серый",
  "Size": "Размер",
  "Text size": "Размер текста",
  "Fine": "Тонкий",
  "Thick": "Толстый",
  "Marker": "Маркер",
  "Thin": "Узкий",
  "Wide": "Широкий",
  "Small": "Маленький",
  "Large": "Большой",
  "Huge": "Огромный",
  "Erase": "Стирать",
  "Whole strokes": "Штрихи целиком",
  "Parts of strokes": "Части штрихов",

  // The sheet
  "Sheet settings": "Настройки листа",
  "Endless sheet": "Бесконечный лист",
  "{n} page | {n} pages": "{n} страница | {n} страницы | {n} страниц",
  "Add a page": "Добавить страницу",
  "Remove the last page": "Убрать последнюю страницу",
  "Plain": "Без узора",
  "Grid": "Сетка",
  "Dots": "Точки",
  "Lines": "Линейки",
  "Draw with finger": "Рисовать пальцем",

  // Zoom
  "Back to 100 %": "Вернуть 100 %",
  "Zoom {percent}%, back to 100 %": "Масштаб {percent}%, вернуть 100 %",
  "Fit the drawing to the window": "Вписать рисунок в окно",

  // Limits
  "This sketch is full: it can hold {n} items at most. Erase something, or start another sketch.": "Эскиз заполнен: в нём может быть не больше {n} элементов. Сотрите что-нибудь или начните другой эскиз.",
  "This sketch is full: there is no room for more strokes. Erase something, or start another sketch.": "Эскиз заполнен: для новых штрихов нет места. Сотрите что-нибудь или начните другой эскиз.",
  "A sketch can hold {n} characters of text at most.": "В эскизе может быть не больше {n} символов текста.",
  "This sketch is too large to save. Erase something, or start another sketch.": "Эскиз слишком большой, чтобы его сохранить. Сотрите что-нибудь или начните другой эскиз.",
  "A sketch can have {n} pages at most.": "В эскизе может быть не больше {n} страниц.",
}
export default messages
