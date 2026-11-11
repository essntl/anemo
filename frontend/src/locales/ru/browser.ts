import type { Messages } from '@/lib/i18n'

/** The agent's browser. */
const messages: Messages = {
  "Browser · {title}": "Браузер · {title}",
  "Back to the chat": "Назад к чату",
  "Back to {title}": "Назад к {title}",
  "Close this browser?": "Закрыть этот браузер?",
  "Its pages, cookies and logins are gone. The agent starts with a fresh browser next time.": "Его страницы, файлы cookie и входы пропадут. В следующий раз агент начнёт с нового браузера.",
  "Close browser": "Закрыть браузер",
  "Address": "Адрес",
  "Enter an address, e.g. example.com": "Введите адрес, напр. example.com",
  "The browser is not running": "Браузер не запущен",
  "Start it on the server with <code>docker compose --profile browser up -d</code>.": "Запустите его на сервере командой <code>docker compose --profile browser up -d</code>.",
  "No page is open yet": "Пока не открыто ни одной страницы",
  "When the agent opens a page in its browser, you see it here and can use it too. You can also enter an address above.": "Когда агент откроет страницу в своём браузере, вы увидите её здесь и тоже сможете ею пользоваться. Адрес можно ввести и вверху.",
  "The agent's browser. Click, type and scroll here.": "Браузер агента. Нажимайте, вводите текст и прокручивайте здесь.",
  "Browser page": "Страница браузера",
  "This is the agent’s browser. Click the page, then type; what you do stays for the agent.": "Это браузер агента. Нажмите на страницу и вводите текст; всё, что вы сделаете, останется для агента.",
  "One browser per chat, shared by you and the agent.": "Один браузер на чат, общий для вас и агента.",
  "Text to type into the page": "Текст для ввода на странице",
  "Type into the page…": "Введите текст для страницы…",
  "Type": "Ввести",
}
export default messages
