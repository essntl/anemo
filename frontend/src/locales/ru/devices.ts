import type { Messages } from '@/lib/i18n'

/** Devices: Settings → Devices (Anemo Desktop on Windows computers, Anemo Voice on phones). */
const messages: Messages = {
  "Devices": "Устройства",
  "Your Windows computers (Anemo Desktop) and phones (Anemo Voice). Each has its own token and, for computers, its own trust level. Changing the trust level asks for your password.": "Ваши компьютеры с Windows (Anemo Desktop) и телефоны (Anemo Voice). У каждого свой токен, а у компьютеров — ещё и свой уровень доверия. Чтобы изменить уровень доверия, нужно ввести пароль.",
  "Add device": "Добавить устройство",
  "e.g. VM, Desk PC, Laptop": "напр., VM, Рабочий ПК, Ноутбук",
  "The agent names the device by it, so keep it short.": "Агент называет устройство этим именем, так что сделайте его коротким.",
  "Computer": "Компьютер",
  "Phone": "Телефон",
  "Trust": "Доверие",
  "Watched": "Под наблюдением",
  "Trusted": "Доверенный",
  "Every click and keystroke asks first; no PowerShell. For your own PC and laptop.": "Каждый клик и нажатие клавиш сначала требуют разрешения; без PowerShell. Для вашего собственного ПК и ноутбука.",
  "As your Agent Permissions say, PowerShell included. For the agent’s own VM.": "Как указано в разрешениях агента, включая PowerShell. Для собственной виртуальной машины агента.",
  "“{name}” is added. Copy its token now: it is shown only this once.": "«{name}» добавлено. Скопируйте его токен сейчас: он показан только этот один раз.",
  "Paste it into Anemo Desktop on that computer, with this address: {address}": "Вставьте его в Anemo Desktop на том компьютере вместе с этим адресом: {address}",
  "Paste it into Anemo Voice on that phone, with this address: {address}": "Вставьте его в Anemo Voice на том телефоне вместе с этим адресом: {address}",
  "Anyone with this token can use your workspace, except changes that need your password, until you delete the device here.": "Любой, у кого есть этот токен, может пользоваться вашим рабочим пространством, кроме изменений, требующих пароля, пока вы не удалите устройство здесь.",
  "Rename “{name}”": "Переименовать «{name}»",
  "Its token stops working and its connection closes at once. To use it again, add it again and paste the new token.": "Его токен сразу перестанет действовать, а соединение закроется. Чтобы снова им пользоваться, добавьте его ещё раз и вставьте новый токен.",
  "Online": "В сети",
  "Offline": "Не в сети",
  "Control off": "Управление выключено",
  "connected now": "подключено сейчас",
  "last seen {when}": "последний раз в сети {when}",
  "never connected": "ещё не подключалось",
  "Trust of “{name}”": "Доверие к «{name}»",
  "The token could not be copied. Select it and copy it yourself.": "Не удалось скопировать токен. Выделите его и скопируйте сами.",
}

export default messages
