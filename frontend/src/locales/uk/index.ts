import type { Messages } from '@/lib/i18n'

/** Every dictionary file in this folder, as one. A text is translated once: the same key in two files must agree. */
const files = import.meta.glob<{ default: Messages }>(['./*.ts', '!./index.ts'], { eager: true })
const messages: Messages = Object.assign({}, ...Object.values(files).map((file) => file.default))
export default messages
