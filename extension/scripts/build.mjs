/**
 * Builds a loadable extension into dist/:
 *   - the pages (vite.config.ts): side panel and focus page
 *   - background.js: the service worker, one ES module
 *   - inpage/*.js: scripts injected into web pages on demand, one IIFE each
 *   - manifest.json, with the version from package.json
 *
 *   node scripts/build.mjs                     production build, into dist/
 *   node scripts/build.mjs --browser-control   the build with browser control, into dist-browser/
 *   node scripts/build.mjs --watch             rebuild on change (development: source maps, debug logs)
 *
 * What differs between the builds is in scripts/manifest.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { manifestFor } from './manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
// --e2e: a copy for the Playwright tests in dist-e2e/, which may reach the local mock
// server without the permission prompt (automation can't click Chrome's own dialogs).
const e2e = process.argv.includes('--e2e')
// --browser-control: the build with browser control (the debugger permission from install).
const browserControl = e2e || process.argv.includes('--browser-control')
const flavor = e2e ? 'e2e' : browserControl ? 'browser-control' : 'normal'
const mode = watch ? 'development' : 'production'
const out = resolve(root, e2e ? 'dist-e2e' : browserControl ? 'dist-browser' : 'dist')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const alias = {
  '@': resolve(root, 'src'),
  '@anemo/schema': resolve(root, '../frontend/src/api/schema.d.ts'),
  '@anemo/timer': resolve(root, '../frontend/src/features/focus/timer.ts'),
}

/**
 * Chrome refuses to load a content script it considers "not UTF-8", and its check also
 * rejects Unicode noncharacters (U+FFFF, U+FDD0…), which minifiers write raw from regex
 * ranges (highlight.js, KaTeX). Every non-ASCII character becomes a \uXXXX escape, which
 * means the same in strings, regular expressions, templates and identifiers.
 */
const asciiOnly = {
  name: 'ascii-only',
  // After the files are written: the minifier would put the characters back.
  writeBundle(options, bundle) {
    for (const file of Object.keys(bundle).filter((f) => f.endsWith('.js'))) {
      const path = resolve(options.dir ?? out, file)
      const code = readFileSync(path, 'utf8')
      writeFileSync(path, code.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')))
    }
  },
}

function common(entry, format, fileName, name) {
  return {
    configFile: false,
    plugins: [asciiOnly],
    mode,
    logLevel: 'warn',
    resolve: { alias },
    define: { __DEV__: JSON.stringify(watch), __E2E__: JSON.stringify(e2e), __BROWSER_CONTROL__: JSON.stringify(browserControl), 'process.env.NODE_ENV': JSON.stringify(mode) },
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'chrome116',
      sourcemap: watch ? 'inline' : false,
      minify: !watch,
      watch: watch ? {} : null,
      lib: { entry, formats: [format], fileName: () => fileName, name },
    },
  }
}

function writeManifest() {
  const manifest = manifestFor(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')), { flavor, version: pkg.version })
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

// The pages first: their build empties dist/.
await build({ configFile: resolve(root, 'vite.config.ts'), mode, logLevel: 'warn', define: { __E2E__: JSON.stringify(e2e), __BROWSER_CONTROL__: JSON.stringify(browserControl) }, build: { outDir: out, watch: watch ? {} : null } })
writeManifest()
await build(common(resolve(root, 'src/background/index.ts'), 'es', 'background.js'))
const inpage = resolve(root, 'src/inpage/entries')
for (const file of readdirSync(inpage).filter((f) => f.endsWith('.ts'))) {
  const name = basename(file, '.ts')
  await build(common(resolve(inpage, file), 'iife', `inpage/${name}.js`, `anemo_${name.replace(/\W/g, '_')}`))
}
console.log(watch ? `Watching for changes (${out})…` : `Built Anemo Companion ${pkg.version}${browserControl ? ' (browser control)' : ''} into ${out}`)
