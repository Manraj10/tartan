// The slice of the shared module the phone page needs. Bundled by build-parser.mjs into the
// PARSER_JS_ string in Code.gs, so the page previews a line with the SAME parser Tartan will
// apply it with — two parsers is two opinions about what "pset friday 5pm" means.
export { parseEntry, everyLabel } from '../../src/shared/types'
