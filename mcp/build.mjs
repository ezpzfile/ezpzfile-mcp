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
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

// Runtime dependencies stay external and are listed in package.json.
// Native or wasm modules (sharp, qpdf, canvas) cannot be bundled at all, and
// the pure JS ones are kept external too so the bundle stays small and
// npm's cache does the deduplication.
const external = [
  'pdfkit', 'fontkit', 'linkedom', 'pdf-lib', 'zod',
  'sharp', 'fflate', 'chardet', 'mammoth', 'xlsx', 'postal-mime', 'qrcode-generator',
  /^@modelcontextprotocol\/sdk/, /^@jspawn\/qpdf-wasm/, /^pdfjs-dist/, /^@napi-rs\/canvas/,
  /^node:/,
]

// The version the server announces comes from package.json and nowhere else.
// Spelled out in the source it gets forgotten: 0.3.1 shipped calling itself 0.2.2.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const bundle = await rolldown({
  input: 'src/index.ts',
  platform: 'node',
  external,
  transform: { define: { __PKG_VERSION__: JSON.stringify(version) } },
  resolve: { alias: { '#': new URL('../src', import.meta.url).pathname } },
})
await bundle.write({
  file: 'dist/index.js',
  format: 'esm',
  comments: false,
  // One file, always. The onnxruntime glue arrives through a dynamic import,
  // which rolldown would otherwise split into a second chunk, and `bin` in
  // package.json can only point at one entry.
  codeSplitting: false,
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
