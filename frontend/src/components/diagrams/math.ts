/**
 * Math in Markdown ($…$ and $$…$$), drawn with KaTeX. Loaded only for texts that contain
 * a `$`. KaTeX's CSS and fonts are bundled with the app; nothing comes from a CDN.
 * `trust: false` keeps commands that could link or load things (\href, \url,
 * \includegraphics) from working.
 */
import 'katex/dist/katex.min.css'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import type { Options } from 'react-markdown'

type PluggableList = NonNullable<Options['remarkPlugins']>

export const remarkPlugins: PluggableList = [[remarkMath, { singleDollarTextMath: true }]]

export const rehypePlugins: PluggableList = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false, maxSize: 20, maxExpand: 500, output: 'htmlAndMathml' }],
]
