import type { Messages } from '@/lib/i18n'

/** Devices: Settings → Devices (Anemo Desktop on Windows computers, Anemo Voice on phones). */
const messages: Messages = {
  "Devices": "Пристрої",
  "Your Windows computers (Anemo Desktop) and phones (Anemo Voice). Each has its own token and, for computers, its own trust level. Changing the trust level asks for your password.": "Ваші комп’ютери з Windows (Anemo Desktop) і телефони (Anemo Voice). Кожен має власний токен, а комп’ютери — ще й власний рівень довіри. Щоб змінити рівень довіри, потрібно ввести пароль.",
  "Add device": "Додати пристрій",
  "e.g. VM, Desk PC, Laptop": "напр., VM, Робочий ПК, Ноутбук",
  "The agent names the device by it, so keep it short.": "Агент називає пристрій цим ім’ям, тож зробіть його коротким.",
  "Computer": "Комп’ютер",
  "Phone": "Телефон",
  "Trust": "Довіра",
  "Watched": "Під наглядом",
  "Trusted": "Довірений",
  "Every click and keystroke asks first; no PowerShell. For your own PC and laptop.": "Кожен клік і натискання клавіш спершу потребує дозволу; без PowerShell. Для вашого власного ПК і ноутбука.",
  "As your Agent Permissions say, PowerShell included. For the agent’s own VM.": "Як вказано в дозволах агента, включно з PowerShell. Для власної віртуальної машини агента.",
  "“{name}” is added. Copy its token now: it is shown only this once.": "«{name}» додано. Скопіюйте його токен зараз: його показано лише цей один раз.",
  "Paste it into Anemo Desktop on that computer, with this address: {address}": "Вставте його в Anemo Desktop на тому комп’ютері разом із цією адресою: {address}",
  "Paste it into Anemo Voice on that phone, with this address: {address}": "Вставте його в Anemo Voice на тому телефоні разом із цією адресою: {address}",
  "Anyone with this token can use your workspace, except changes that need your password, until you delete the device here.": "Будь-хто з цим токеном може користуватися вашим робочим простором, окрім змін, що потребують пароля, доки ви не видалите пристрій тут.",
  "Rename “{name}”": "Перейменувати «{name}»",
  "Its token stops working and its connection closes at once. To use it again, add it again and paste the new token.": "Його токен одразу перестане діяти, а з’єднання закриється. Щоб знову ним користуватися, додайте його ще раз і вставте новий токен.",
  "Online": "У мережі",
  "Offline": "Не в мережі",
  "Control off": "Керування вимкнено",
  "connected now": "під’єднано зараз",
  "last seen {when}": "востаннє в мережі {when}",
  "never connected": "ще не під’єднувався",
  "Trust of “{name}”": "Довіра до «{name}»",
  "The token could not be copied. Select it and copy it yourself.": "Не вдалося скопіювати токен. Виділіть його й скопіюйте самостійно.",
  "Files on your computers": "Файли на ваших комп’ютерах",
  "On a trusted computer with “Let Anemo read and write files” switched on in Anemo Desktop, the agent can copy files between it and the workspace. Anemo Desktop decides which folders: your home folder unless you list others, never hidden or system folders.": "На довіреному комп’ютері, де в Anemo Desktop увімкнено «Let Anemo read and write files», агент може копіювати файли між ним і робочим простором. Які теки, вирішує Anemo Desktop: ваша домашня тека, якщо ви не вкажете інші, і ніколи приховані чи системні теки.",
  "Largest file (MB)": "Найбільший файл (МБ)",
  "From {min} to {max} MB.": "Від {min} до {max} МБ.",
}

export default messages
