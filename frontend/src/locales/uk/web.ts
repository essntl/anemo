import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "Test search": "Перевірити пошук",
  "Web search": "Пошук в інтернеті",
  "Agents search the web through your SearXNG instance. Without one, the web search tool is not offered.": "Агенти шукають в інтернеті через ваш екземпляр SearXNG. Без нього інструмент пошуку в інтернеті не пропонується.",
  "Empty: uses {url} from the .env file.": "Порожньо: використовується {url} з файлу .env.",
  "e.g. http://searxng:8080 or http://192.168.1.20:8888": "напр. http://searxng:8080 або http://192.168.1.20:8888",
  "SearXNG must allow JSON results: in its <code>settings.yml</code> set <code>search: formats: [html, json]</code>.": "SearXNG має дозволяти результати у форматі JSON: у його <code>settings.yml</code> задайте <code>search: formats: [html, json]</code>.",
  "Results per search": "Результатів на пошук",
  "Safe search": "Безпечний пошук",
  "Moderate": "Помірний",
  "Strict": "Суворий",
  "Language": "Мова",
  "\"auto\" or a code like en, de-DE": "«auto» або код на кшталт en, de-DE",
  "Your network": "Ваша мережа",
  "Web pages, API calls and the browser used by agents can't reach your home network, this server or its containers. Allow specific hosts here when an agent should talk to them.": "Вебсторінки, виклики API та браузер, яким користуються агенти, не мають доступу до вашої домашньої мережі, цього сервера та його контейнерів. Дозвольте тут окремі хости, з якими агент має працювати.",
  "Allowed hosts": "Дозволені хости",
  "One per line: a host name (nas.lan), an IP address (192.168.1.20) or a range (192.168.1.0/24).": "По одному на рядок: ім’я хоста (nas.lan), IP-адреса (192.168.1.20) або діапазон (192.168.1.0/24).",
  "An allowed host is reachable by any agent run that may read web pages, call APIs or use the browser, including runs steered by text on a web page. Allow only what agents need, and prefer services with their own login. Shell commands with network access are separate: they can reach your network anyway.": "Дозволений хост доступний будь-якому запуску агента, якому можна читати вебсторінки, викликати API чи користуватися браузером, зокрема запускам, якими керує текст на вебсторінці. Дозволяйте лише те, що агентам потрібно, і надавайте перевагу сервісам із власним входом. Команди оболонки з доступом до мережі розглядаються окремо: вони й так мають доступ до вашої мережі.",
  "Saved. New agent runs use these settings.": "Збережено. Нові запуски агентів використовуватимуть ці налаштування.",
  "Web & Search": "Інтернет і пошук",
  "How agents search and read the web. Whether they may at all is set in <a>Agent Permissions</a>.": "Як агенти шукають і читають в інтернеті. Чи можна їм це взагалі, задається в розділі <a>Дозволи агентів</a>.",
}
export default messages
