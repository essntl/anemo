# Translations

English is the source language: the English text in the code is the key. Each other
language has a folder here (`uk`, `ru`) with one file per area of the app; `index.ts`
merges them. `common.ts` holds the words used everywhere; the other files don't repeat
its keys. See `src/lib/i18n.tsx` for `t`, `plural`, `rich`, `msg` and `dateLocale`.

`locales.test.ts` fails when a text in the code has no translation in a language, or a
translation loses a `{place}` or `<tag>`.

## Style (Ukrainian and Russian)

- Address the user formally and in lower case: «ви», «вы». Buttons and menu items are
  infinitives: «Зберегти», «Сохранить».
- Product and protocol names stay as they are: Anemo, MCP, YouTube, Markdown, Chrome.
- Quotes are «…»; the Ukrainian apostrophe is ’ (U+2019); keep … and – as in English.
- Plurals: three forms, `one | few | many`: `"{n} файл | {n} файли | {n} файлів"`.

## Glossary

| English | Українська | Русский |
|---|---|---|
| chat | чат | чат |
| agent | агент | агент |
| run | запуск | запуск |
| task | завдання | задача |
| Inbox | Вхідні | Входящие |
| Settings | Налаштування | Настройки |
| document | документ | документ |
| file / folder | файл / тека | файл / папка |
| project | проєкт | проект |
| Memory / a memory | Пам’ять / спогад | Память / воспоминание |
| automation | автоматизація | автоматизация |
| schedule | розклад | расписание |
| focus session | сеанс фокусування | сеанс фокусировки |
| break | перерва | перерыв |
| queue / playlist / track | черга / плейлист / трек | очередь / плейлист / трек |
| skill | навичка | навык |
| (agent) profile | профіль | профиль |
| provider / model | провайдер / модель | провайдер / модель |
| workspace | робочий простір | рабочее пространство |
| approval / approve / deny | підтвердження / дозволити / відхилити | подтверждение / разрешить / отклонить |
| permission | дозвіл | разрешение |
| notification | сповіщення | уведомление |
| reminder | нагадування | напоминание |
| Trash | Кошик | Корзина |
| shared link | спільне посилання | общая ссылка |
| sandbox | пісочниця | песочница |
| tool | інструмент | инструмент |
| widget | віджет | виджет |
| pinned | закріплений | закреплённый |
| sidebar | бічна панель | боковая панель |
| sign in / sign out | увійти / вийти | войти / выйти |
| password | пароль | пароль |
| event (calendar) | подія | событие |
| due | термін | срок |
| attachment | вкладення | вложение |
| web search | пошук в інтернеті | поиск в интернете |
| browser | браузер | браузер |
| shortcut | комбінація клавіш | сочетание клавиш |
