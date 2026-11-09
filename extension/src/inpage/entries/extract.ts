// Defines window.__anemoExtract in the extension's isolated world of this page; the
// extension then calls it with a second executeScript (a file's own value is not returned).
import { extract } from '../extract'

;(window as unknown as { __anemoExtract?: typeof extract }).__anemoExtract = extract
