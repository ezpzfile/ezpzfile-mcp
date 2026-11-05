/**
 * Eight jobs an agent composes from several calls, run over stdio against
 * dist/index.js. Each step uses only what the previous result returned
 * (addresses from doc_inspect, the anchor from a RULE error), the way an agent
 * would. Prints one line per step and the time each scenario took.
 *
 *   python3 test/make-samples.py /tmp/samples
 *   node test/scenarios.mjs /tmp/samples
 *
 * HWP scenarios use doc-rebuilt.hwp, which test/protocol.mjs makes from doc.pdf;
 * run that first, or the HWP scenarios are skipped.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '/tmp/samples')
const here = new URL('.', import.meta.url).pathname
const f = (n) => join(dir, n)
const client = new Client({ name: 'ezpzfile-scenarios', version: '0.0.0' })
await client.connect(new StdioClientTransport({ command: 'node', args: [join(here, '..', 'dist', 'index.js')], env: process.env }))

let failed = 0
let calls = 0
const report = []
async function call(name, args) {
  calls++
  const res = await client.callTool({ name, arguments: args })
  return { ...res, text: res.content?.[0]?.text ?? '', data: res.structuredContent ?? {} }
}
function must(label, ok, extra = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` (${extra})` : ''}`)
  if (!ok) failed++
  return ok
}
async function scenario(title, run) {
  console.log(`\n# ${title}`)
  const before = calls
  const t0 = Date.now()
  try {
    await run()
  } catch (err) {
    must('no exception', false, String(err?.message ?? err))
  }
  report.push({ title, calls: calls - before, ms: Date.now() - t0 })
}

// 1. Quote from a template: inspect, fill, check.
await scenario('1. DOCX quote from a template', async () => {
  const i = await call('doc_inspect', { path: f('quote-template.docx') })
  must('placeholders listed', /\{\{customer\}\}/.test(i.text) && /items\.name/.test(i.text))
  const out = f('quote-1.docx')
  const c = await call('doc_create', {
    template: f('quote-template.docx'),
    out,
    values: { customer: '한빛상사', date: '2026-11-05', items: [{ name: 'A4 용지', qty: 10, price: '5,000' }, { name: '토너', qty: 2, price: '80,000' }], total: '210,000', owner: '이민수' },
  })
  must('filled, nothing left', c.data.left?.length === 0 && c.data.rowsAdded === 1, c.text.split('\n')[1])
  const k = await call('doc_check', { path: out })
  must('doc_check passes', k.data.passed === true)
})

// 2. A cell behind a merged cell: the RULE error names the anchor, retry there.
await scenario('2. Edit a merged table cell after a RULE error', async () => {
  const out = f('quote-2.docx')
  const bad = await call('doc_edit', { path: f('quote-1.docx'), out, ops: [{ op: 'set_cell', table: 0, row: 3, col: 1, text: '총액' }] })
  must('RULE error', bad.isError && bad.data.error?.code === 'RULE', bad.data.error?.message)
  const anchor = bad.data.error?.details?.anchor ?? { row: 3, col: 0 }
  const good = await call('doc_edit', { path: f('quote-1.docx'), out, ops: [{ op: 'set_cell', table: 0, row: anchor.row ?? 3, col: anchor.col ?? 0, text: '총액' }] })
  must('retry at the anchor confirmed', good.data.verify?.allConfirmed === true)
})

// 3. Dry run first, then the real edit.
await scenario('3. Dry run, then write', async () => {
  const out = f('quote-3.docx')
  rmSync(out, { force: true })
  // the last row is the merged total row; the RULE error says which row to copy instead
  const probe = await call('doc_edit', { path: f('quote-1.docx'), dry_run: true, ops: [{ op: 'append_row', table: 0, cells: ['배송', '1', '3,000'] }] })
  must('RULE names a plain row', probe.data.error?.code === 'RULE' && probe.data.error.details?.row >= 1)
  const row = probe.data.error?.details?.row ?? 2
  const ops = [{ op: 'replace_text', find: '한빛상사', replace: '새빛상사' }, { op: 'append_row', table: 0, row, cells: ['배송', '1', '3,000'] }]
  const dry = await call('doc_edit', { path: f('quote-1.docx'), out, ops, dry_run: true })
  must('dry run confirmed and wrote nothing', dry.data.verify?.allConfirmed === true && !existsSync(out))
  const real = await call('doc_edit', { path: f('quote-1.docx'), out, ops })
  must('written and confirmed', real.data.verify?.allConfirmed === true && existsSync(out))
  const r = await call('doc_read', { path: out, format: 'markdown' })
  must('new row and name read back', r.text.includes('배송') && r.text.includes('새빛상사'))
})

// 4. Redact personal details in a PDF and prove they are gone.
await scenario('4. Redact a PDF and check', async () => {
  const out = f('people-redacted.pdf')
  const r = await call('pdf_edit', { op: 'redact', paths: [f('people.pdf')], find: ['김하늘', '010-1234-5678', '세종대로 110'], out })
  must('all phrases found', Object.values(r.data.found ?? {}).every((n) => n > 0), JSON.stringify(r.data.found))
  must('reopened, nothing left', r.data.verify?.allConfirmed === true)
  const t = await call('doc_read', { path: out })
  must('text no longer has the name', !t.text.includes('김하늘'))
  const p = await call('doc_render', { path: out, pages: [1], dpi: 72, out: f('people-redacted-pages') })
  must('rendered', p.data.files?.length === 1)
})

const hwp = f('doc-rebuilt.hwp')
if (existsSync(hwp)) {
  // 5. HWP: find a table by inspecting, change a cell by its address, read it back.
  await scenario('5. HWP cell edit by address from doc_inspect', async () => {
    const i = await call('doc_inspect', { path: hwp })
    const t = i.data.tables?.[0]
    if (!must('a table to edit', Boolean(t))) return
    const out = f('doc-cell.hwp')
    const e = await call('doc_edit', { path: hwp, out, ops: [{ op: 'set_cell', table: t.table, row: 0, col: 0, text: '바뀐 머리칸' }] })
    must('edit confirmed', e.data.verify?.allConfirmed === true)
    const j = await call('doc_read', { path: out, format: 'json' })
    must('json shows the cell', j.text.includes('바뀐 머리칸'))
  })

  // 6. HWP to a filled template to PDF, checked.
  await scenario('6. HWP template to PDF', async () => {
    const tpl = f('doc-template.hwp')
    const i = await call('doc_inspect', { path: hwp })
    const first = i.data.firstParagraphs?.[0]
    if (!must('a paragraph to template', Boolean(first))) return
    await call('doc_edit', { path: hwp, out: tpl, ops: [{ op: 'insert_paragraph', section: first.section, paragraph: first.paragraph, text: '수신: {{to}} / 일자: {{date}}' }] })
    const made = f('doc-made.hwp')
    const c = await call('doc_create', { template: tpl, out: made, values: { to: '총무팀', date: '2026-11-05' } })
    must('filled', c.data.left?.length === 0, c.text.split('\n')[1])
    const pdf = await call('doc_convert', { path: made, to: 'pdf', out: f('doc-made.pdf') })
    must('converted', !pdf.isError, pdf.text.split('\n')[1])
    const k = await call('doc_check', { path: f('doc-made.pdf'), forbid: ['{{'] })
    must('no placeholder in the PDF', k.data.passed === true)
  })

  // 7. HWP to Word, edit there, tables kept.
  await scenario('7. HWP to DOCX, then edit the Word file', async () => {
    const d = await call('doc_convert', { path: hwp, to: 'docx', out: f('doc-from-hwp.docx') })
    must('tables carried', d.data.tablesBack === d.data.tables, `${d.data.tables} tables`)
    const e = await call('doc_edit', { path: f('doc-from-hwp.docx'), ops: [{ op: 'insert_paragraph', paragraph: 0, text: '검토본' }] })
    must('edit confirmed', e.data.verify?.allConfirmed === true)
  })
}

// 9. One design, a list of people, one file each: from sample text (no placeholders).
await scenario('9. Batch from a design and a list (PDF and SVG)', async () => {
  for (const t of ['quote-template.pdf', 'card.svg']) {
    if (!existsSync(f(t))) continue
    const match = t.endsWith('.pdf') ? { '{{owner}}': 'name' } : { 홍길동: 'name', 디자이너: 'title', '010-0000-0000': 'phone' }
    const dir = f(`batch-${t.split('.').pop()}`)
    rmSync(dir, { recursive: true, force: true })
    const r = await call('doc_create', { template: f(t), data: f('people.csv'), match, out_dir: dir, name_pattern: 'card-{{name}}' })
    must(`${t}: 3 files made`, r.data.made === 3 && r.data.failed === 0, r.text.split('\n')[0])
    if (t.endsWith('.pdf')) {
      const back = await call('doc_read', { path: join(dir, 'card-박서연.pdf') })
      must('the name is in the third file', back.text.includes('박서연'))
    }
  }
})

// 10. A CAD drawing: what is in it, its text, a PDF of it.
await scenario('10. CAD drawing: inspect, read, PDF', async () => {
  const i = await call('doc_inspect', { path: f('plan.dxf') })
  must('two layers found', /WALLS/.test(i.text) && /NOTES/.test(i.text), i.text.split('\n')[0])
  const t = await call('doc_read', { path: f('plan.dxf') })
  must('texts read', t.text.includes('FLOOR PLAN 1F'))
  const p = await call('doc_convert', { path: f('plan.dxf'), to: 'pdf', out: f('plan.pdf') })
  must('PDF reopened with one page', p.data.reopenedPages === 1)
  const back = await call('doc_read', { path: f('plan.pdf') })
  must('PDF text layer has the drawing text', back.text.includes('SCALE 1:100'))
})

// 11–12. The design engines (downloaded once from ezpzfile.com, or EZPZFILE_ENGINES_DIR).
if (process.env.EZPZ_DESIGN_TESTS !== '0') {
  await scenario('11. SVG/AI through the vector engine: find text, hide, change, export', async () => {
    const i = await call('doc_inspect', { path: f('card.svg') })
    const name = (i.data.items ?? []).find((x) => x.text === '홍길동')
    if (!must('text object listed with its id', Boolean(name), i.text.split('\n')[0])) return
    const bar = (i.data.items ?? []).find((x) => x.kind !== 'Type' && x.kind !== 'Layer')
    const e = await call('doc_edit', { path: f('card.svg'), out: f('card-edited.png'), ops: [{ op: 'set_text', id: name.id, text: '김하늘' }, ...(bar ? [{ op: 'hide', ids: [bar.id] }] : [])] })
    must('confirmed and written', e.data.verify?.allConfirmed === true && e.data.verify?.written?.bytes > 0, e.text.split('\n')[0])
    const r = await call('doc_render', { path: f('card.svg'), ids: [name.id], out: f('card-objects') })
    must('one object drawn alone', r.data.files?.length === 1)
  })
  if (existsSync(f('sample.psd'))) {
    await scenario('12. PSD: layers, hide one, save as PNG', async () => {
      const i = await call('doc_inspect', { path: f('sample.psd') })
      const layer = (i.data.items ?? []).find((x) => x.depth === 0)
      const e = await call('doc_edit', { path: f('sample.psd'), out: f('sample-hidden.png'), ops: [{ op: 'hide', ids: [layer.id] }] })
      must('confirmed and written', e.data.verify?.allConfirmed === true, e.text.split('\n')[0])
    })
  }
}

// 13. Which font is this? (models from ff.ezpzfile.com; EZPZ_FONTFIND_TESTS=0 skips)
if (process.env.EZPZ_FONTFIND_TESTS !== '0') {
  await scenario('13. Font finder on a page of a PDF', async () => {
    const r = await call('font_find', { path: f('people.pdf'), limit: 5 })
    must('text read and fonts ranked', r.data.matches?.length === 5 && r.data.read?.length > 3, r.text.split('\n')[0])
    must('free fonts carry a page and a licence', r.data.matches.some((m) => m.price === 'free' && m.page && m.licence))
  })
}

// 8. Unknown and wrong inputs come back as codes with needs, not prose.
await scenario('8. Errors an agent can act on', async () => {
  const a = await call('doc_edit', { path: f('quote-1.docx'), ops: [{ op: 'set_cell', table: 0, row: 0 }] })
  must('BAD_ARGUMENT names what is missing', a.data.error?.code === 'BAD_ARGUMENT' && a.data.error.needs.includes('col'))
  const b = await call('doc_edit', { path: f('quote-1.docx'), ops: [{ op: 'replace_text', find: '없는 말', replace: 'x' }] })
  must('NOT_APPLIED when nothing matched', b.data.error?.code === 'NOT_APPLIED')
  const c = await call('doc_read', { path: f('no-such-file.docx') })
  must('NOT_FOUND', c.data.error?.code === 'NOT_FOUND')
  const d = await call('doc_render', { path: f('report.docx') })
  must('UNSUPPORTED with the profile to read', d.data.error?.code === 'UNSUPPORTED' && /ezpzfile:\/\/formats\/docx/.test(d.data.error.message))
})

const res = await client.listResources()
console.log(`\nresources: ${res.resources.map((r) => r.uri).join(', ')}`)
const prof = await client.readResource({ uri: 'ezpzfile://formats/hwp' })
must('hwp profile readable', JSON.parse(prof.contents[0].text).edit.length > 0)

console.log('\n| Scenario | Calls | Time |\n| --- | --- | --- |')
for (const r of report) console.log(`| ${r.title} | ${r.calls} | ${(r.ms / 1000).toFixed(1)} s |`)
await client.close()
console.log(failed ? `\n${failed} FAILED` : '\nALL SCENARIOS PASSED')
process.exit(failed ? 1 : 0)
