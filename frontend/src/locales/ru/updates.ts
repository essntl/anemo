import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "and {n} older": "и ещё {n} более старых",
  "Copy the update command": "Копировать команду обновления",
  "Switched off with UPDATE_CHECK=false in .env.": "Выключено через UPDATE_CHECK=false в .env.",
  "This build doesn’t say which commit it was made from, so it can’t be compared with main.": "Эта сборка не содержит сведений о коммите, из которого она сделана, поэтому её нельзя сравнить с main.",
  "Switched off. Anemo doesn’t ask GitHub about updates.": "Выключено. Anemo не запрашивает GitHub об обновлениях.",
  "Not checked yet. Anemo looks about once a day.": "Ещё не проверялось. Anemo проверяет примерно раз в день.",
  "Up to date with main.": "Актуальная версия: совпадает с main.",
  "Couldn’t check: {reason}.": "Не удалось проверить: {reason}.",
  "unknown reason": "неизвестная причина",
  "Updates": "Обновления",
  "Check now": "Проверить сейчас",
  "Check for updates": "Проверять обновления",
  "About once a day, ask GitHub ({repo}) how many changes its main branch has that this version doesn’t. Nothing about you is sent. Anemo never updates itself.": "Примерно раз в день спрашивать GitHub ({repo}), сколько изменений есть в ветке main, которых нет в этой версии. Никакие данные о вас не отправляются. Anemo никогда не обновляется сам.",
  "New changes on main": "Новые изменения в main",
  "To update, run this in Anemo’s folder on the server:": "Чтобы обновить, выполните эту команду в папке Anemo на сервере:",
  "The prebuilt images record it. A build from a checkout does when started with <code>make up</code>, or with <code>APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build</code>.": "Готовые образы его записывают. Сборка из локальной копии репозитория записывает, если запущена через <code>make up</code> или <code>APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build</code>.",
  "Last checked {when}": "Последняя проверка: {when}",
  "What’s new": "Что нового",
  "Got it": "Понятно",
  "Changes in this update": "Изменения в этом обновлении",
  "{n} new change on main since this version. | {n} new changes on main since this version.": "{n} новое изменение в main после этой версии. | {n} новых изменения в main после этой версии. | {n} новых изменений в main после этой версии.",
  "Anemo was updated from {from} to {to}: {n} change. | Anemo was updated from {from} to {to}: {n} changes.": "Anemo обновлён с {from} до {to}: {n} изменение. | Anemo обновлён с {from} до {to}: {n} изменения. | Anemo обновлён с {from} до {to}: {n} изменений.",
}
export default messages
