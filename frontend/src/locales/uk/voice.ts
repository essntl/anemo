import type { Messages } from '@/lib/i18n'

/** Voice: Settings → Voice, and voice requests on a run's page. */
const messages: Messages = {
  "Voice": "Голос",
  "A new one each day": "Новий щодня",
  "One that keeps going": "Один, що триває",
  "Talk to Anemo from your phone with the Anemo Voice app: say the wake word and what you want. It runs as an agent request in a Voice chat, and the phone reads the answer out.": "Говоріть з Anemo з телефона в застосунку Anemo Voice: скажіть слово активації й те, що вам потрібно. Це виконується як запит до агента в голосовому чаті, а телефон зачитує відповідь уголос.",
  "Agent for voice requests": "Агент для голосових запитів",
  "Its tools and permissions apply, as in the chat.": "Діють його інструменти й дозволи, як у чаті.",
  "The Voice chat": "Голосовий чат",
  "Where voice requests go when they don’t follow up on an answer.": "Куди потрапляють голосові запити, які не продовжують попередню відповідь.",
  "Follow-up window (minutes)": "Час на уточнення (хвилини)",
  "A request this soon after an answer continues that chat, so “and move it to Friday” knows what “it” is. 0 turns follow-ups off.": "Запит, зроблений так скоро після відповіді, продовжує той самий чат, тож «і перенеси це на п’ятницю» знає, що таке «це». 0 вимикає уточнення.",
  "Longest answer read out (characters)": "Найдовша відповідь уголос (символи)",
  "A longer answer is cut at the end of a sentence, followed by “The rest is in the chat.”": "Довшу відповідь обрізано в кінці речення, а далі звучить «The rest is in the chat.» (решта — у чаті).",
  "Allow approvals by voice": "Дозволяти підтвердження голосом",
  "Answer “Allow?” and plan reviews with yes or no. Dangerous actions always need a tap on the notification. Off: questions are still answered by voice.": "Відповідайте «так» чи «ні» на «Дозволити?» і на перегляд плану. Небезпечні дії завжди потребують натискання на сповіщенні. Вимкнено: на запитання все одно можна відповідати голосом.",
  "Models and phones": "Моделі й телефони",
  "Voice uses the dictation models (<link>Providers & Models</link>): <b>Transcription</b> hears the request and <b>Dictation clean-up</b> turns it into one clear instruction. The words in <dictation>Dictation</dictation> apply too. Neither the recording nor what was heard is kept; the request is saved as your chat message.": "Голос використовує моделі диктування (<link>Провайдери та моделі</link>): <b>Транскрипція</b> розпізнає запит, а <b>Упорядкування диктування</b> перетворює його на одну чітку інструкцію. Слова з розділу <dictation>Диктування</dictation> теж діють. Ні запис, ні розпізнаний текст не зберігаються; запит зберігається як ваше повідомлення в чаті.",
  "The wake word, the voice the phone speaks with and the headset are set in the app on the phone.": "Слово активації, голос, яким говорить телефон, і гарнітуру налаштовують у застосунку на телефоні.",
  "Asked by voice from {phone}": "Запит голосом з {phone}",
  "Asked by voice": "Запит голосом",
}
export default messages
