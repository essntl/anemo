import type { Messages } from '@/lib/i18n'

const messages: Messages = {
  "Sign in to continue": "Войдите, чтобы продолжить",
  "Username": "Имя пользователя",
  "Password": "Пароль",
  "Sign in": "Войти",
  "Confirm it's you": "Подтвердите, что это вы",
  "This is a security-sensitive setting. Enter your password to continue.": "Эта настройка влияет на безопасность. Введите пароль, чтобы продолжить.",
  "Can’t reach Anemo": "Не удаётся связаться с Anemo",
  "{reason} This page tries again when the connection is back.": "{reason} Страница попробует снова, когда соединение восстановится.",
  "You’re offline.": "Вы не в сети.",
  "Trying…": "Пробуем…",
  "Copy the token now: it is shown only this once.": "Скопируйте токен сейчас: он показывается только в этот раз.",
  "Paste it into Anemo Companion (or the device it is for). Anyone with this token can use your workspace, except changes that need your password, until you revoke it here.": "Вставьте его в Anemo Companion (или на устройстве, для которого он предназначен). Любой, у кого есть этот токен, может пользоваться вашим рабочим пространством (кроме изменений, для которых нужен пароль), пока вы не отзовёте его здесь.",
  "Revoke “{name}”?": "Отозвать «{name}»?",
  "Whatever uses this token is signed out at once (for the extension: it goes back to its setup screen).": "Всё, что использует этот токен, сразу потеряет вход (расширение вернётся к экрану настройки).",
  "Revoke": "Отозвать",
  "Extension and device tokens": "Токены расширения и устройств",
  "Long-lived logins for Anemo Companion (the browser extension) or other devices. Each is shown once when created and can be revoked here.": "Долгосрочные входы для Anemo Companion (расширения браузера) или других устройств. Каждый показывается один раз при создании, и его можно отозвать здесь.",
  "Chrome on my laptop": "Chrome на моём ноутбуке",
  "Create token": "Создать токен",
  "Where it will be used, e.g. “Chrome on my laptop”.": "Где он будет использоваться, напр. «Chrome на моём ноутбуке».",
  "created {when}": "создан {when}",
  "last used {when} from {ip}": "последнее использование {when} с {ip}",
  "last used {when}": "последнее использование {when}",
  "never used": "не использовался",
}
export default messages
