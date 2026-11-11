import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "and {n} older": "і ще {n} давніших",
  "Copy the update command": "Копіювати команду оновлення",
  "Switched off with UPDATE_CHECK=false in .env.": "Вимкнено через UPDATE_CHECK=false у .env.",
  "This build doesn’t say which commit it was made from, so it can’t be compared with main.": "Ця збірка не містить відомостей про коміт, з якого її зроблено, тому її не можна порівняти з main.",
  "Switched off. Anemo doesn’t ask GitHub about updates.": "Вимкнено. Anemo не запитує GitHub про оновлення.",
  "Not checked yet. Anemo looks about once a day.": "Ще не перевірялося. Anemo перевіряє приблизно раз на день.",
  "Up to date with main.": "Актуальна версія: збігається з main.",
  "Couldn’t check: {reason}.": "Не вдалося перевірити: {reason}.",
  "unknown reason": "невідома причина",
  "Updates": "Оновлення",
  "Check now": "Перевірити зараз",
  "Check for updates": "Перевіряти оновлення",
  "About once a day, ask GitHub ({repo}) how many changes its main branch has that this version doesn’t. Nothing about you is sent. Anemo never updates itself.": "Приблизно раз на день запитувати GitHub ({repo}), скільки змін є в гілці main, яких немає в цій версії. Жодні дані про вас не надсилаються. Anemo ніколи не оновлюється сам.",
  "New changes on main": "Нові зміни в main",
  "To update, run this in Anemo’s folder on the server:": "Щоб оновити, виконайте цю команду в теці Anemo на сервері:",
  "The prebuilt images record it. A build from a checkout does when started with <code>make up</code>, or with <code>APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build</code>.": "Готові образи його записують. Збірка з локальної копії репозиторію записує, якщо запущена через <code>make up</code> або <code>APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build</code>.",
  "Last checked {when}": "Остання перевірка: {when}",
  "What’s new": "Що нового",
  "Got it": "Зрозуміло",
  "Changes in this update": "Зміни в цьому оновленні",
  "{n} new change on main since this version. | {n} new changes on main since this version.": "{n} нова зміна в main після цієї версії. | {n} нові зміни в main після цієї версії. | {n} нових змін у main після цієї версії.",
  "Anemo was updated from {from} to {to}: {n} change. | Anemo was updated from {from} to {to}: {n} changes.": "Anemo оновлено з {from} до {to}: {n} зміна. | Anemo оновлено з {from} до {to}: {n} зміни. | Anemo оновлено з {from} до {to}: {n} змін.",
}
export default messages
