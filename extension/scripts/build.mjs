/**
 * Builds a loadable extension into dist/:
 *   - the pages (vite.config.ts): side panel and focus page
 *   - background.js: the service worker, one ES module
 *   - inpage/*.js: scripts injected into web pages on demand, one IIFE each
 *   - manifest.json, with the version from package.json
 *
 *   node scripts/build.mjs           production build
 *   node scripts/build.mjs --watch   rebuild on change (development: source maps, debug logs)
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
// --e2e: a copy for the Playwright tests in dist-e2e/, which may reach the local mock
// server without the permission prompt (automation can't click Chrome's own dialogs).
const e2e = process.argv.includes('--e2e')
const mode = watch ? 'development' : 'production'
const out = resolve(root, e2e ? 'dist-e2e' : 'dist')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const alias = {
  '@': resolve(root, 'src'),
  '@anemo/schema': resolve(root, '../frontend/src/api/schema.d.ts'),
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
    define: { __DEV__: JSON.stringify(watch), __E2E__: JSON.stringify(e2e), 'process.env.NODE_ENV': JSON.stringify(mode) },
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
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
  manifest.version = pkg.version
  if (e2e) manifest.host_permissions = ['http://127.0.0.1/*']
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

// The pages first: their build empties dist/.
await build({ configFile: resolve(root, 'vite.config.ts'), mode, logLevel: 'warn', define: { __E2E__: JSON.stringify(e2e) }, build: { outDir: out, watch: watch ? {} : null } })
writeManifest()
await build(common(resolve(root, 'src/background/index.ts'), 'es', 'background.js'))
const inpage = resolve(root, 'src/inpage/entries')
for (const file of readdirSync(inpage).filter((f) => f.endsWith('.ts'))) {
  const name = basename(file, '.ts')
  await build(common(resolve(inpage, file), 'iife', `inpage/${name}.js`, `anemo_${name.replace(/\W/g, '_')}`))
}
console.log(watch ? `Watching for changes (${out})…` : `Built Anemo Companion ${pkg.version} into ${out}`)
