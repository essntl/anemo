import type { Messages } from '@/lib/i18n'

/** The agent's browser. */
const messages: Messages = {
  "Browser · {title}": "Браузер · {title}",
  "Back to the chat": "Назад до чату",
  "Back to {title}": "Назад до {title}",
  "Close this browser?": "Закрити цей браузер?",
  "Its pages, cookies and logins are gone. The agent starts with a fresh browser next time.": "Його сторінки, файли cookie та входи зникнуть. Наступного разу агент почне з нового браузера.",
  "Close browser": "Закрити браузер",
  "Address": "Адреса",
  "Enter an address, e.g. example.com": "Введіть адресу, напр. example.com",
  "The browser is not running": "Браузер не запущено",
  "Start it on the server with <code>docker compose --profile browser up -d</code>.": "Запустіть його на сервері командою <code>docker compose --profile browser up -d</code>.",
  "No page is open yet": "Ще не відкрито жодної сторінки",
  "When the agent opens a page in its browser, you see it here and can use it too. You can also enter an address above.": "Коли агент відкриє сторінку у своєму браузері, ви побачите її тут і теж зможете нею користуватися. Адресу можна ввести й угорі.",
  "The agent's browser. Click, type and scroll here.": "Браузер агента. Клацайте, вводьте текст і прокручуйте тут.",
  "Browser page": "Сторінка браузера",
  "This is the agent’s browser. Click the page, then type; what you do stays for the agent.": "Це браузер агента. Клацніть сторінку й вводьте текст; усе, що ви зробите, залишиться для агента.",
  "One browser per chat, shared by you and the agent.": "Один браузер на чат, спільний для вас і агента.",
  "Text to type into the page": "Текст для введення на сторінці",
  "Type into the page…": "Введіть текст для сторінки…",
  "Type##verb": "Ввести",
}
export default messages
