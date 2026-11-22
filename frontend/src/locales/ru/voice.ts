import type { Messages } from '@/lib/i18n'

/** Voice: Settings → Voice, and voice requests on a run's page. */
const messages: Messages = {
  "Voice": "Голос",
  "A new one each day": "Новый каждый день",
  "One that keeps going": "Один, который продолжается",
  "Talk to Anemo from your phone with the Anemo Voice app: say the wake word and what you want. It runs as an agent request in a Voice chat, and the phone reads the answer out.": "Говорите с Anemo с телефона в приложении Anemo Voice: скажите слово активации и то, что вам нужно. Это выполняется как запрос к агенту в голосовом чате, а телефон зачитывает ответ вслух.",
  "Agent for voice requests": "Агент для голосовых запросов",
  "Model for voice requests": "Модель для голосовых запросов",
  "A small, fast model keeps spoken answers quick and cheap. “The agent’s model” uses the agent’s own, else the Agent model in Providers & Models.": "Небольшая быстрая модель делает голосовые ответы быстрыми и дешёвыми. «Модель агента» означает собственную модель агента, а если её нет, то модель для агента из раздела «Провайдеры и модели».",
  "The agent’s model": "Модель агента",
  "Its tools and permissions apply, as in the chat.": "Действуют его инструменты и разрешения, как в чате.",
  "The Voice chat": "Голосовой чат",
  "Where voice requests go when they don’t follow up on an answer.": "Куда попадают голосовые запросы, которые не продолжают предыдущий ответ.",
  "Follow-up window (minutes)": "Время на уточнение (минуты)",
  "A request this soon after an answer continues that chat, so “and move it to Friday” knows what “it” is. 0 turns follow-ups off.": "Запрос, сделанный так скоро после ответа, продолжает тот же чат, поэтому «и перенеси это на пятницу» знает, что такое «это». 0 отключает уточнения.",
  "Longest answer read out (characters)": "Самый длинный ответ вслух (символы)",
  "A longer answer is cut at the end of a sentence, followed by “The rest is in the chat.”": "Более длинный ответ обрезается в конце предложения, а дальше звучит «The rest is in the chat.» (остальное — в чате).",
  "Allow approvals by voice": "Разрешать подтверждения голосом",
  "Answer “Allow?” and plan reviews with yes or no. Dangerous actions always need a tap on the notification. Off: questions are still answered by voice.": "Отвечайте «да» или «нет» на «Разрешить?» и на просмотр плана. Опасные действия всегда требуют нажатия в уведомлении. Выключено: на вопросы всё равно можно отвечать голосом.",
  "Models and phones": "Модели и телефоны",
  "Voice uses the dictation models (<link>Providers & Models</link>): <b>Transcription</b> hears the request and <b>Dictation clean-up</b> turns it into one clear instruction. The words in <dictation>Dictation</dictation> apply too. Neither the recording nor what was heard is kept; the request is saved as your chat message.": "Голос использует модели диктовки (<link>Провайдеры и модели</link>): <b>Транскрипция</b> распознаёт запрос, а <b>Обработка диктовки</b> превращает его в одну чёткую инструкцию. Слова из раздела <dictation>Диктовка</dictation> тоже действуют. Ни запись, ни распознанный текст не сохраняются; запрос сохраняется как ваше сообщение в чате.",
  "The wake word, the voice the phone speaks with and the headset are set in the app on the phone.": "Слово активации, голос, которым говорит телефон, и гарнитура настраиваются в приложении на телефоне.",
  "Asked by voice from {phone}": "Запрос голосом с {phone}",
  "Asked by voice": "Запрос голосом",
}
export default messages
