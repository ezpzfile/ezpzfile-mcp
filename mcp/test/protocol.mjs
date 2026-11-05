/**
 * End to end check over stdio: spawn dist/index.js, list tools, call each
 * one with a real file, print the human summary. Run after `npm run build`:
 *
 *   python3 test/make-samples.py /path/to/samples   # the files this expects
 *   node test/protocol.mjs /path/to/samples
 *
 * Calling the functions directly is not enough. The server must survive the
 * actual transport, and anything a dependency prints to stdout would break
 * the JSON-RPC stream. This is where that would show up.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '/tmp/samples')
const here = new URL('.', import.meta.url).pathname
const client = new Client({ name: 'ezpzfile-test', version: '0.0.0' })
await client.connect(new StdioClientTransport({ command: 'node', args: [join(here, '..', 'dist', 'index.js')] }))

// What the handshake announces has to be what was published. 0.3.1 went out
// calling itself 0.2.2 because nothing here looked.
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const announced = client.getServerVersion()?.version
console.log('serverInfo:', JSON.stringify(client.getServerVersion()))
if (announced !== pkg.version) {
  throw new Error(`server announces ${announced}, package.json says ${pkg.version}`)
}

const { tools } = await client.listTools()
console.log('tools/list:', tools.map((t) => t.name).join(', '))
if (tools.length !== 11) throw new Error(`expected 11 tools, got ${tools.length}`)

let failures = 0
/** A field of the last result that must hold, e.g. expect('replaced 4', r.structuredContent.replaced === 4). */
function expect(label, ok) {
  if (ok) return
  failures += 1
  console.log('  expectation failed:', label)
}
async function call(name, args, expectPath) {
  const t0 = Date.now()
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.[0]?.text ?? ''
  const tag = res.isError ? 'ERR ' : 'ok  '
  console.log(`\n[${tag}] ${name} ${JSON.stringify(args).slice(0, 110)} (${Date.now() - t0}ms)`)
  console.log('  ' + text.split('\n').slice(0, 6).join('\n  ').slice(0, 600))
  if (res.isError && !args.__expectError) failures += 1
  if (!res.isError && args.__expectError) {
    failures += 1
    console.log('  expected an error here')
  }
  if (expectPath) {
    const p = res.structuredContent?.path ?? res.structuredContent?.dir
    if (!p || !existsSync(p)) {
      failures += 1
      console.log('  output path missing:', p)
    } else console.log('  wrote', p, statSync(p).isDirectory() ? '(dir)' : `${statSync(p).size} bytes`)
  }
  return res
}
const f = (n) => join(dir, n)
const optional = (n) => existsSync(f(n))

// doc_read
await call('doc_read', { path: f('report.docx'), format: 'markdown' })
await call('doc_read', { path: f('mail.eml') })
await call('doc_read', { path: f('doc.pdf') })
if (optional('sample.hwp')) await call('doc_read', { path: f('sample.hwp') })
if (optional('sample.hwpx')) await call('doc_read', { path: f('sample.hwpx') })
await call('doc_read', { path: f('photo.jpg'), __expectError: true })
// Ichitaro and DocuWorks, read by our own engines
if (optional('sample.jtd')) await call('doc_read', { path: f('sample.jtd'), format: 'markdown' })
if (optional('sample.xdw')) await call('doc_read', { path: f('sample.xdw') })
if (optional('sample.xbd')) {
  const r = await call('doc_read', { path: f('sample.xbd'), format: 'markdown' })
  expect('a binder lists its documents', Array.isArray(r.structuredContent?.binder) && r.structuredContent.binder.length > 0)
}
// metadata: what a file says about itself
{
  const r = await call('doc_read', { path: f('photo_exif.jpg'), format: 'metadata' })
  expect('GPS position found', r.structuredContent?.geo?.lat !== undefined)
}
await call('doc_read', { path: f('report.docx'), format: 'metadata' })
await call('doc_read', { path: f('doc.pdf'), format: 'metadata' })
if (optional('sample.jtd')) await call('doc_read', { path: f('sample.jtd'), format: 'metadata' })
// Files that only say .hwp: each must fail and say what the file really is.
for (const [n, says] of [['fake-pdf.hwp', /PDF/], ['fake-web.hwp', /web page/], ['empty.hwp', /empty/]]) {
  if (!optional(n)) continue
  const r = await call('doc_read', { path: f(n), __expectError: true })
  expect(`${n} explained`, says.test(r.content?.[0]?.text ?? ''))
}

// doc_convert
await call('doc_convert', { path: f('table.xlsx'), to: 'csv' }, true)
await call('doc_convert', { path: f('table.xlsx'), to: 'json', sheet: '메모', out: f('memo.json') }, true)
await call('doc_convert', { path: f('table_euckr.csv'), to: 'json' }, true)
await call('doc_convert', { path: f('doc.pdf'), to: 'png', pages: [1, 2], dpi: 96 }, true)
await call('doc_convert', { path: f('doc.pdf'), to: 'jpg', pages: [3], out: f('jpgs') }, true)
await call('doc_convert', { path: f('photo.jpg'), paths: [f('logo.png'), f('photo.webp')], to: 'pdf', out: f('images.pdf') }, true)
await call('doc_convert', { path: f('photo.jpg'), to: 'pdf', pageSize: 'a4', out: f('images-a4.pdf') }, true)
if (optional('sample.hwp')) await call('doc_convert', { path: f('sample.hwp'), to: 'pdf', out: f('sample-from-hwp.pdf') }, true)
if (optional('sample.hwpx')) await call('doc_convert', { path: f('sample.hwpx'), to: 'hwp', out: f('sample-from-hwpx.hwp') }, true)
// PDF back into editable documents, each reopened by the tool itself
for (const to of ['docx', 'xlsx', 'hwpx', 'hwp']) {
  const r = await call('doc_convert', { path: f('doc.pdf'), to, out: f(`doc-rebuilt.${to}`) }, true)
  expect(`pdf to ${to} verified`, r.structuredContent?.verified === true)
}
await call('doc_read', { path: f('doc-rebuilt.hwp') })
// HWP tables read by cell address, as markdown, as json, and carried into Word
for (const n of ['doc-rebuilt.hwp', 'tables.hwp', 'tables.hwpx']) {
  if (n !== 'doc-rebuilt.hwp' && !optional(n)) continue
  const r = await call('doc_read', { path: f(n), format: 'markdown' })
  const t = r.content?.[0]?.text ?? ''
  if (r.structuredContent?.tables > 0) expect(`${n} tables counted in the header`, /^\[Tables: \d+/.test(t) && /\||<table/.test(t))
  const j = await call('doc_read', { path: f(n), format: 'json' })
  expect(`${n} json parses`, (() => { try { return Array.isArray(JSON.parse(j.content[0].text.slice(j.content[0].text.indexOf('\n\n') + 2)).sections) } catch { return false } })())
  const d = await call('doc_convert', { path: f(n), to: 'docx', out: f(`${n}-tables.docx`) }, true)
  expect(`${n} docx table count matches`, d.structuredContent?.tablesBack === d.structuredContent?.tables)
}
await call('doc_read', { path: f('doc-rebuilt.docx'), format: 'markdown' })
await call('doc_convert', { path: f('doc.pdf'), to: 'csv', __expectError: true })
if (optional('sample.jtd')) {
  await call('doc_convert', { path: f('sample.jtd'), to: 'docx', out: f('sample-jtd.docx') }, true)
  const r = await call('doc_convert', { path: f('sample.jtd'), to: 'pdf', out: f('sample-jtd.pdf') }, true)
  expect('jtd pdf page count', r.structuredContent?.pageMatch === true)
  await call('doc_convert', { path: f('sample.jtd'), to: 'hwp', __expectError: true })
}
if (optional('sample.xdw')) {
  const r = await call('doc_convert', { path: f('sample.xdw'), to: 'pdf', out: f('sample-xdw.pdf') }, true)
  expect('xdw pdf page count', r.structuredContent?.pageMatch === true)
}
if (optional('sample.xbd')) await call('doc_convert', { path: f('sample.xbd'), to: 'pdf', out: f('sample-xbd.pdf') }, true)
if (optional('photo.heic')) {
  await call('doc_convert', { path: f('photo.heic'), paths: [f('photo.jpg')], to: 'pdf', out: f('heic.pdf') }, true)
}

// pdf_edit
await call('pdf_edit', { op: 'merge', paths: [f('doc.pdf'), f('images.pdf')], out: f('merged.pdf') }, true)
await call('pdf_edit', { op: 'extract', paths: [f('doc.pdf')], pages: [2, 4] }, true)
await call('pdf_edit', { op: 'delete', paths: [f('doc.pdf')], pages: [1] }, true)
await call('pdf_edit', { op: 'rotate', paths: [f('doc.pdf')], pages: [1], degrees: 90 }, true)
await call('pdf_edit', { op: 'reorder', paths: [f('doc.pdf')], order: [4, 3, 2, 1] }, true)
await call('pdf_edit', { op: 'split', paths: [f('doc.pdf')], at: [3], out: f('split') }, true)
await call('pdf_edit', { op: 'compress', paths: [f('merged.pdf')] }, true)
await call('pdf_edit', { op: 'protect', paths: [f('doc.pdf')], password: 'secret', allowCopy: false, out: f('locked.pdf') }, true)
await call('pdf_edit', { op: 'unlock', paths: [f('locked.pdf')], password: 'wrong', __expectError: true })
await call('pdf_edit', { op: 'unlock', paths: [f('locked.pdf')], password: 'secret', out: f('unlocked.pdf') }, true)
await call('doc_read', { path: f('locked.pdf'), password: 'secret' })
await call('pdf_info', { path: f('locked.pdf') })
await call('pdf_info', { path: f('unlocked.pdf') })
// replace_text: changes the text in the content stream, reopens and counts what is left
{
  const r = await call('pdf_edit', { op: 'replace_text', paths: [f('doc.pdf')], find: 'ACME Corp', replace: 'Globex Inc', out: f('replaced.pdf') }, true)
  expect('replaced at least once', (r.structuredContent?.replaced ?? 0) > 0)
  expect('nothing replaceable left', r.structuredContent?.remaining === (r.structuredContent?.split ?? 0) + (r.structuredContent?.failed?.length ?? 0))
}
await call('pdf_edit', { op: 'replace_text', paths: [f('doc.pdf')], find: 'no such phrase', replace: 'x', __expectError: true })
await call('pdf_edit', { op: 'replace_text', paths: [f('locked.pdf')], find: 'ACME', replace: 'x', __expectError: true })

// image_edit
await call('image_edit', { path: f('photo.jpg'), op: 'resize', width: 400 }, true)
await call('image_edit', { path: f('logo.png'), op: 'resize', height: 100, format: 'webp' }, true)
await call('image_edit', { path: f('photo.jpg'), op: 'compress', quality: 40 }, true)
await call('image_edit', { path: f('photo.webp'), op: 'convert', format: 'png' }, true)
await call('image_edit', { path: f('logo.png'), op: 'convert', format: 'jpeg', out: f('logo-flat.jpg') }, true)
await call('image_edit', { path: f('photo_exif.jpg'), op: 'strip_metadata' }, true)
await call('image_edit', { path: f('doc.pdf'), op: 'strip_metadata' }, true)
await call('image_edit', { path: f('photo.jpg'), op: 'resize', __expectError: true })
// iPhone photos: decoded by libheif, written as JPEG unless format says otherwise
if (optional('photo.heic')) {
  const r = await call('image_edit', { path: f('photo.heic'), op: 'resize', width: 400 }, true)
  expect('heic resized to jpeg', r.structuredContent?.format === 'jpeg' && r.structuredContent?.width === 400)
  await call('image_edit', { path: f('photo.heic'), op: 'convert', format: 'webp', out: f('heic.webp') }, true)
  await call('image_edit', { path: f('photo.heic'), op: 'strip_metadata', __expectError: true })
}

// qr_make
await call('qr_make', { text: 'https://ezpzfile.com', out: f('qr.png') }, true)
await call('qr_make', { text: '안녕하세요 QR', out: f('qr.svg'), level: 'H', dark: '#1a3a7a', margin: 2 }, true)
await call('qr_make', { text: 'x', out: f('qr.gif'), __expectError: true })

// Cutting out a background downloads a 4.4MB model and a 14MB runtime the
// first time, so it stays off the default run. EZPZ_TEST_MATTE=1 turns it on.
if (process.env.EZPZ_TEST_MATTE === '1') {
  await call('image_edit', { path: f('photo.jpg'), op: 'remove_background' }, true)
}

await client.close()
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
