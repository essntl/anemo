import type { Messages } from '@/lib/i18n'

/** Long chats: /compact, the divider where a chat was compacted, the warning and the setting. */
const messages: Messages = {
  "This chat is at {tokens} tokens. /compact summarizes it.": "Этот чат занимает {tokens} токенов. /compact подытожит его.",
  "This chat will be compacted before your next message.": "Этот чат будет сжат перед вашим следующим сообщением.",
  "This chat is at {tokens} of {at} tokens: it will be compacted when it passes {at} (/compact does it now).": "Этот чат занимает {tokens} из {at} токенов: он будет сжат, когда превысит {at} (/compact сделает это сейчас).",
  "Compacting the chat…": "Сжатие чата…",
  "The chat could not be compacted": "Не удалось сжать чат",
  "Compacted here ({before} → {after} tokens)": "Сжато здесь ({before} → {after} токенов)",
  "Compacted here": "Сжато здесь",
  "Kept in detail: {focus}": "Сохранено подробно: {focus}",
  "Long chats": "Длинные чаты",
  "A long chat is summarized, so every message no longer re-reads all of it. The chat itself stays as it is; /compact in the message box does it at once.": "Длинный чат подытоживается, чтобы каждое сообщение не перечитывало его целиком. Сам чат остаётся как есть; /compact в поле сообщения делает это сразу.",
  "Compact a chat by itself when it gets long": "Сжимать чат автоматически, когда он становится длинным",
  "Compact at (thousands of tokens)": "Сжимать при (тысячи токенов)",
  "Between 20 and 2000. Chats on the Claude subscription use it as Claude Code’s own compaction point.": "От 20 до 2000. Чаты на подписке Claude используют это как собственную точку сжатия Claude Code.",
}
export default messages
