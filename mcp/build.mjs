/**
 * Bundle the server into a single file. Shared site code (svgPdf, qrOps,
 * pdfLayout, ...) is pulled in here so there is only ever one copy of it.
 *
 * rolldown is used because the repository already depends on it. Only the
 * bundled output ships, so this stays a build-time dependency.
 *
 * Comments are stripped from the bundle: the sources carry Korean notes that
 * have no place in a published package.
 */
import { rolldown } from 'rolldown'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Runtime dependencies stay external and are listed in package.json.
// Native or wasm modules (sharp, qpdf, canvas) cannot be bundled at all, and
// the pure JS ones are kept external too so the bundle stays small and
// npm's cache does the deduplication.
const external = [
  'pdfkit', 'fontkit', 'linkedom', 'pdf-lib', 'zod',
  'sharp', 'fflate', 'chardet', 'mammoth', 'xlsx', 'postal-mime', 'qrcode-generator',
  /^@modelcontextprotocol\/sdk/, /^@jspawn\/qpdf-wasm/, /^pdfjs-dist/, /^@napi-rs\/canvas/, /^@pdf-lib\/fontkit/,
  /^node:/,
]

/**
 * Site modules written for the browser, and their Node versions in src/shims.
 *
 * The site code reused here (PDF to Word, Excel and HWP, text replacement in
 * PDFs) reaches pdfjs, the HWP engine and the canvas through these three
 * modules. Inside this bundle every import of them gets the Node version
 * instead, so the shared code runs unchanged. The shims themselves still see
 * the originals and re-export whatever needs no change.
 */
const siteLib = resolve(here, '..', 'src', 'lib')
const shimDir = resolve(here, 'src', 'shims')
const SHIMS = new Map(
  ['pdfOps', 'rhwp', 'pdfImagePng'].map((name) => [join(siteLib, `${name}.ts`), join(shimDir, `${name}.ts`)]),
)

const nodeShims = {
  name: 'ezpz-node-shims',
  resolveId(source, importer) {
    if (!importer || importer.startsWith(shimDir)) return null
    let target
    if (source.startsWith('#/')) target = resolve(here, '..', 'src', source.slice(2))
    else if (source.startsWith('.')) target = resolve(dirname(importer), source)
    else return null
    return SHIMS.get(target.endsWith('.ts') ? target : `${target}.ts`) ?? null
  },
}

// The version the server announces comes from package.json and nowhere else.
// Spelled out in the source it gets forgotten: 0.3.1 shipped calling itself 0.2.2.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const bundle = await rolldown({
  input: 'src/index.ts',
  platform: 'node',
  external,
  plugins: [nodeShims],
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

/**
 * The newest version folder of an engine in public/vendor. The website keeps
 * each engine in a folder named after its version, because /vendor is cached
 * for a year and a changed file must get a new address.
 */
function versionFolder(name) {
  const base = `../public/vendor/${name}`
  const key = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number)
  const versions = readdirSync(base)
    .filter((v) => /^\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)]
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i]
      return 0
    })
  if (!versions[0]) throw new Error(`No version folder in ${base}`)
  return `${base}/${versions[0]}`
}

// Ship the engines and the fonts inside the package so that nothing has to be
// downloaded after install.
rmSync('vendor', { recursive: true, force: true })
mkdirSync('vendor/rhwp', { recursive: true })
for (const f of ['rhwp.js', 'rhwp_bg.wasm', 'LICENSE']) {
  cpSync(`../public/vendor/rhwp/0.8.4/${f}`, `vendor/rhwp/${f}`)
}
// Only the fonts this package draws with (the site folder holds more, for its editors).
mkdirSync('vendor/fonts', { recursive: true })
for (const f of ['NanumGothic-Regular.ttf', 'NanumMyeongjo-Regular.ttf', 'NotoSansKR-Regular.otf', 'NotoSansJP-Regular.otf',
  'OFL-Nanum.txt', 'OFL-NotoSansKR.txt', 'OFL-NotoSansJP.txt', 'PROVENANCE.json']) {
  cpSync(`../public/vendor/fonts/${f}`, `vendor/fonts/${f}`)
}
// Ichitaro (JTD) and DocuWorks (XDW): our own engines, MIT.
for (const name of ['ezpzjtd', 'ezpzxdw']) {
  cpSync(versionFolder(name), `vendor/${name}`, { recursive: true })
}
// HEIC decoding. libheif is LGPL-3.0, so it stays a separate file that can be
// swapped out, never melted into the bundle. Its licence travels with it.
cpSync(versionFolder('libheif'), 'vendor/libheif', { recursive: true })
for (const f of ['vendor/ezpzjtd/ezpzjtd_wasm_bg.wasm', 'vendor/ezpzxdw/ezpzxdw_wasm_bg.wasm', 'vendor/libheif/libheif.wasm', 'vendor/libheif/LICENSE']) {
  if (!existsSync(f)) throw new Error(`build: ${f} is missing`)
}
console.log('dist/index.js + vendor/ ready')
