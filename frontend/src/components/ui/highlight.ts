import rehypeHighlight from 'rehype-highlight'
import type { Options } from 'react-markdown'

/** Code highlighting for Markdown (highlight.js, ~150 kB: loaded by useHighlight only
 * when a text has a fenced code block). Only blocks that name their language. */
export const HIGHLIGHT: NonNullable<Options['rehypePlugins']>[number] = [rehypeHighlight, { detect: false, ignoreMissing: true }]
