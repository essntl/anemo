import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "Test search": "Проверить поиск",
  "Web search": "Поиск в интернете",
  "Agents search the web through your SearXNG instance. Without one, the web search tool is not offered.": "Агенты ищут в интернете через ваш экземпляр SearXNG. Без него инструмент поиска в интернете не предлагается.",
  "Empty: uses {url} from the .env file.": "Пусто: используется {url} из файла .env.",
  "e.g. http://searxng:8080 or http://192.168.1.20:8888": "напр. http://searxng:8080 или http://192.168.1.20:8888",
  "SearXNG must allow JSON results: in its <code>settings.yml</code> set <code>search: formats: [html, json]</code>.": "SearXNG должен разрешать результаты в формате JSON: в его <code>settings.yml</code> задайте <code>search: formats: [html, json]</code>.",
  "Results per search": "Результатов на поиск",
  "Safe search": "Безопасный поиск",
  "Moderate": "Умеренный",
  "Strict": "Строгий",
  "Language": "Язык",
  "\"auto\" or a code like en, de-DE": "«auto» или код вроде en, de-DE",
  "Your network": "Ваша сеть",
  "Web pages, API calls and the browser used by agents can't reach your home network, this server or its containers. Allow specific hosts here when an agent should talk to them.": "Веб-страницы, вызовы API и браузер, которым пользуются агенты, не имеют доступа к вашей домашней сети, этому серверу и его контейнерам. Разрешите здесь отдельные хосты, с которыми агент должен работать.",
  "Allowed hosts": "Разрешённые хосты",
  "One per line: a host name (nas.lan), an IP address (192.168.1.20) or a range (192.168.1.0/24).": "По одному на строку: имя хоста (nas.lan), IP-адрес (192.168.1.20) или диапазон (192.168.1.0/24).",
  "An allowed host is reachable by any agent run that may read web pages, call APIs or use the browser, including runs steered by text on a web page. Allow only what agents need, and prefer services with their own login. Shell commands with network access are separate: they can reach your network anyway.": "Разрешённый хост доступен любому запуску агента, которому можно читать веб-страницы, вызывать API или пользоваться браузером, в том числе запускам, которыми управляет текст на веб-странице. Разрешайте только то, что нужно агентам, и предпочитайте сервисы с собственным входом. Команды оболочки с доступом к сети рассматриваются отдельно: они и так имеют доступ к вашей сети.",
  "Saved. New agent runs use these settings.": "Сохранено. Новые запуски агентов будут использовать эти настройки.",
  "Web & Search": "Интернет и поиск",
  "How agents search and read the web. Whether they may at all is set in <a>Agent Permissions</a>.": "Как агенты ищут и читают в интернете. Можно ли им это вообще, задаётся в разделе <a>Разрешения агентов</a>.",
}
export default messages
