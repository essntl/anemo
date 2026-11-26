import type { Messages } from '@/lib/i18n'

/** Long chats: /compact, the divider where a chat was compacted, the warning and the setting. */
const messages: Messages = {
  "This chat is at {tokens} tokens. /compact summarizes it.": "Цей чат займає {tokens} токенів. /compact підсумує його.",
  "This chat will be compacted before your next message.": "Цей чат буде стиснуто перед вашим наступним повідомленням.",
  "This chat is at {tokens} of {at} tokens: it will be compacted when it passes {at} (/compact does it now).": "Цей чат займає {tokens} з {at} токенів: його буде стиснуто, коли він перевищить {at} (/compact зробить це зараз).",
  "Compacting the chat…": "Стискання чату…",
  "The chat could not be compacted": "Не вдалося стиснути чат",
  "Compacted here ({before} → {after} tokens)": "Стиснуто тут ({before} → {after} токенів)",
  "Compacted here": "Стиснуто тут",
  "Kept in detail: {focus}": "Збережено докладно: {focus}",
  "Long chats": "Довгі чати",
  "A long chat is summarized, so every message no longer re-reads all of it. The chat itself stays as it is; /compact in the message box does it at once.": "Довгий чат підсумовується, щоб кожне повідомлення не перечитувало його весь. Сам чат лишається як є; /compact у полі повідомлення робить це одразу.",
  "Compact a chat by itself when it gets long": "Стискати чат автоматично, коли він стає довгим",
  "Compact at (thousands of tokens)": "Стискати при (тисячі токенів)",
  "Between 20 and 2000. Chats on the Claude subscription use it as Claude Code’s own compaction point.": "Від 20 до 2000. Чати на підписці Claude використовують це як власну точку стискання Claude Code.",
}
export default messages
