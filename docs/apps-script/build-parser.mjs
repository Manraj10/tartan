// Bundle the shared parser and splice it into Code.gs as the PARSER_JS_ string.
// Run after any change to parseEntry in src/shared/types.ts:  node docs/apps-script/build-parser.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const outfile = path.join(here, '.parser-bundle.js')

const esbuild = await import(pathToFileURL(path.join(repo, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
await esbuild.build({
  entryPoints: [path.join(here, 'parser-entry.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'TP',
  outfile,
})

const js = fs.readFileSync(outfile, 'utf8').trim()
fs.rmSync(outfile)

const escaped = js.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')
const gsPath = path.join(here, 'Code.gs')
const gs = fs.readFileSync(gsPath, 'utf8')
const marker = /var PARSER_JS_ =\s*'(?:[^'\\]|\\[\s\S])*';/
if (!marker.test(gs)) throw new Error('PARSER_JS_ marker not found in Code.gs')
// A replacer function, or $-sequences inside the minified bundle corrupt the splice.
const next = gs.replace(marker, () => `var PARSER_JS_ = '${escaped}';`)
fs.writeFileSync(gsPath, next)
console.log(`inlined ${js.length} chars of parser (escaped ${escaped.length}) into Code.gs`)
