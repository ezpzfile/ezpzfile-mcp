/**
 * Timings for the README: real jobs of the people who use this server, each run as an
 * agent would run it, over stdio against dist/index.js. Prints a markdown table.
 *
 *   python3 test/make-samples.py /tmp/samples
 *   node test/protocol.mjs /tmp/samples      # makes doc-rebuilt.hwp
 *   node test/bench.mjs /tmp/samples
 *
 * Optional samples: poster-text.png (a line of text in a known font) and name-tag.pdf
 * (a PDF whose font is not installed here). Rows without their sample are skipped.
 * First runs include one-time downloads (engines, models); the warm column is a second run.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '/tmp/samples')
const here = new URL('.', import.meta.url).pathname
const f = (n) => join(dir, n)
const client = new Client({ name: 'ezpzfile-bench', version: '0.0.0' })
await client.connect(new StdioClientTransport({ command: 'node', args: [join(here, '..', 'dist', 'index.js')], env: process.env }))

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args })
  return { ...res, text: res.content?.[0]?.text ?? '', data: res.structuredContent ?? {} }
}
const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const dirSize = (d) => readdirSync(d).reduce((a, n) => a + statSync(join(d, n)).size, 0)

// a list of 100 people
const family = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임']
const given = ['하늘', '민준', '서연', '지우', '도윤', '하은', '시우', '수아', '예준', '지호']
const titles = ['디자이너', '개발자', '기획자', '마케터', '영업']
const rows = ['name,title,phone']
for (let i = 0; i < 100; i++) rows.push(`${family[i % 10]}${given[Math.floor(i / 10)]},${titles[i % 5]},010-${String(2000 + i)}-${String(7000 + i)}`)
writeFileSync(f('people-100.csv'), rows.join('\n'))

const results = []
async function job(who, title, run) {
  if (run === null) return
  const times = []
  let note = ''
  for (let k = 0; k < 2; k++) {
    const t0 = Date.now()
    try {
      note = (await run()) ?? ''
    } catch (err) {
      note = `FAILED: ${err?.message ?? err}`
    }
    times.push(Date.now() - t0)
  }
  results.push({ who, title, cold: times[0], warm: times[1], note })
  console.error(`${title}: ${times.join(' / ')} ms · ${note}`)
}
const need = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

await job('Office, Korea', 'Read every table of an HWP', existsSync(f('doc-rebuilt.hwp')) ? async () => {
  const r = await call('doc_read', { path: f('doc-rebuilt.hwp'), format: 'markdown' })
  need(!r.isError, r.text)
  return 'tables as markdown, merged cells kept'
} : null)

await job('Office, Korea', 'Fill an HWP form, convert to PDF, check', existsSync(f('doc-template.hwp')) ? async () => {
  const c = await call('doc_create', { template: f('doc-template.hwp'), out: f('bench-made.hwp'), values: { to: '총무팀', date: '2026-11-05' } })
  need(c.data.left?.length === 0, c.text)
  await call('doc_convert', { path: f('bench-made.hwp'), to: 'pdf', out: f('bench-made.pdf') })
  const k = await call('doc_check', { path: f('bench-made.pdf'), forbid: ['{{'] })
  need(k.data.passed, k.text)
  return '3 calls, nothing left'
} : null)

await job('Sales', 'Quote from a DOCX template (split placeholder, item rows)', async () => {
  const c = await call('doc_create', { template: f('quote-template.docx'), out: f('bench-quote.docx'), values: { customer: '한빛상사', date: '2026-11-05', items: [{ name: 'A4 용지', qty: 10, price: '5,000' }, { name: '토너', qty: 2, price: '80,000' }], total: '210,000', owner: '이민수' } })
  need(c.data.left?.length === 0, c.text)
  return `1 call, ${c.data.rowsAdded} row added, nothing left`
})

await job('Sales', '100 quotes from a PDF design and a list', async () => {
  const out = f('bench-pdf-100')
  rmSync(out, { recursive: true, force: true })
  const r = await call('doc_create', { template: f('quote-template.pdf'), data: f('people-100.csv'), match: { '{{owner}}': 'name' }, out_dir: out, name_pattern: 'quote-{{name}}' })
  need(r.data.made === 100, r.text)
  return `100 files, ${kb(dirSize(out) / 100)} each, checked`
})

await job('Design', '100 business cards from an SVG/AI design and a list', async () => {
  const out = f('bench-card-100')
  rmSync(out, { recursive: true, force: true })
  const r = await call('doc_create', { template: f('card.svg'), data: f('people-100.csv'), match: { 홍길동: 'name', 디자이너: 'title', '010-0000-0000': 'phone' }, out_dir: out, name_pattern: 'card-{{name}}' })
  need(r.data.made === 100, r.text)
  return '100 files'
})

await job('Design', 'PSD: hide a layer, save as PNG', existsSync(f('sample.psd')) ? async () => {
  const i = await call('doc_inspect', { path: f('sample.psd') })
  const layer = (i.data.items ?? []).find((x) => x.depth === 0)
  const e = await call('doc_edit', { path: f('sample.psd'), out: f('bench-hidden.png'), ops: [{ op: 'hide', ids: [layer.id] }] })
  need(e.data.verify?.allConfirmed, e.text)
  return `2 calls, ${i.data.items.length} layers listed, confirmed`
} : null)

await job('Design', 'Which font is this? (picture)', existsSync(f('poster-text.png')) ? async () => {
  const r = await call('font_find', { path: f('poster-text.png'), limit: 5 })
  need(!r.isError, r.text)
  return `#1 ${r.data.matches[0].name} ${r.data.matches[0].similarity}%`
} : null)

await job('Design', 'Change a name in a PDF whose font is not installed', existsSync(f('name-tag.pdf')) ? async () => {
  const r = await call('pdf_edit', { op: 'replace_text', paths: [f('name-tag.pdf')], find: '홍길동', replace: '김철수', out: f('bench-name-tag.pdf') })
  need(!r.isError && r.data.remaining === 0, r.text)
  return `same font fetched, ${kb(statSync(f('bench-name-tag.pdf')).size)}`
} : null)

await job('Privacy', 'Redact a name, phone and address in a PDF, prove it', async () => {
  const r = await call('pdf_edit', { op: 'redact', paths: [f('people.pdf')], find: ['김하늘', '010-1234-5678', '세종대로 110'], out: f('bench-redacted.pdf') })
  need(r.data.verify?.allConfirmed, r.text)
  const k = await call('doc_check', { path: f('bench-redacted.pdf'), forbid: ['김하늘', '010-1234-5678'] })
  need(k.data.passed, k.text)
  return '2 calls, nothing left to extract'
})

await job('Architecture', 'CAD drawing: layers, text, vector PDF', async () => {
  await call('doc_inspect', { path: f('plan.dxf') })
  await call('doc_read', { path: f('plan.dxf') })
  const p = await call('doc_convert', { path: f('plan.dxf'), to: 'pdf', out: f('bench-plan.pdf') })
  need(p.data.reopenedPages === 1, p.text)
  return '3 calls, text stays text'
})

await client.close()
// node test/bench.mjs <samples> --save  → docs/bench.json, which the repository README is built from
if (process.argv.includes('--save')) writeFileSync(join(here, '..', 'docs', 'bench.json'), JSON.stringify({ measured: new Date().toISOString().slice(0, 10), machine: `Node ${process.versions.node}, ${process.platform}, ${(await import('node:os')).cpus().length} cores`, results }, null, 2) + '\n')
console.log('| Who | Job | First run | Again | Result |')
console.log('| --- | --- | --- | --- | --- |')
const s = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
for (const r of results) console.log(`| ${r.who} | ${r.title} | ${s(r.cold)} | ${s(r.warm)} | ${r.note} |`)
