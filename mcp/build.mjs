/**
 * Bundle the server into a single file. Shared site code (svgPdf, qrOps) is
 * pulled in here so there is only ever one copy of it.
 *
 * rolldown is used because the repository already depends on it. Only the
 * bundled output ships, so this stays a build-time dependency.
 *
 * Comments are stripped from the bundle: the sources carry Korean notes that
 * have no place in a published package.
 */
import { rolldown } from 'rolldown'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

// Runtime dependencies stay external and are listed in package.json.
// Native or wasm modules (sharp, qpdf, canvas) cannot be bundled at all, and
// the pure JS ones are kept external too so the bundle stays small and
// npm's cache does the deduplication.
const external = [
  'pdfkit', 'fontkit', 'linkedom', 'pdf-lib', 'zod',
  'sharp', 'fflate', 'chardet', 'mammoth', 'xlsx', 'postal-mime', 'qrcode-generator',
  /^@modelcontextprotocol\/sdk/, /^@jspawn\/qpdf-wasm/, /^pdfjs-dist/, /^@napi-rs\/canvas/, /^node:/,
]

const bundle = await rolldown({
  input: 'src/index.ts',
  platform: 'node',
  external,
  resolve: { alias: { '#': new URL('../src', import.meta.url).pathname } },
})
await bundle.write({
  file: 'dist/index.js',
  format: 'esm',
  comments: false,
})

// Ship the engine and the fonts inside the package so that nothing has to be
// downloaded after install.
rmSync('vendor', { recursive: true, force: true })
mkdirSync('vendor/rhwp', { recursive: true })
for (const f of ['rhwp.js', 'rhwp_bg.wasm', 'LICENSE']) {
  cpSync(`../public/vendor/rhwp/0.8.4/${f}`, `vendor/rhwp/${f}`)
}
cpSync('../public/vendor/fonts', 'vendor/fonts', { recursive: true })
console.log('dist/index.js + vendor/ ready')
