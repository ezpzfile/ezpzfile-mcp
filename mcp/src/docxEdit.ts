/**
 * DOCX: inspect, edit by op list, fill templates, working on word/document.xml.
 * Text Word split over several runs is joined for matching, so "{{name}}" or a
 * phrase is found however Word stored it; the first run's formatting is kept.
 *
 * Addresses (ezpzfile://formats/docx):
 *   paragraph {paragraph}       body-level paragraphs, from 0 (not those inside tables)
 *   table     {table}           every table in reading order, nested included, from 0
 *   cell      {table, row, col} grid position from 0; a merged cell by its top-left cell
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import mammoth from 'mammoth'
import { DOMParser } from 'linkedom'
import { ToolError } from './result'

type El = {
  tagName: string
  childNodes: ArrayLike<Node>
  parentNode: El | null
  getElementsByTagName(n: string): ArrayLike<El>
  getAttribute(n: string): string | null
  setAttribute(n: string, v: string): void
  removeChild(n: unknown): void
  insertBefore(n: unknown, ref: unknown): void
  appendChild(n: unknown): void
  cloneNode(deep: boolean): El
  textContent: string | null
  nextSibling: unknown
  ownerDocument: { createElement(n: string): El }
}
type Node = El

const kids = (e: El, tag?: string): El[] => Array.from(e.childNodes as ArrayLike<El>).filter((n) => n.tagName && (!tag || n.tagName === tag))
const all = (e: El, tag: string): El[] => Array.from(e.getElementsByTagName(tag))

interface Opened {
  files: Record<string, Uint8Array>
  decl: string
  doc: { documentElement: El; toString(): string }
  body: El
}

function open(bytes: Uint8Array): Opened {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new ToolError('UNREADABLE', 'This is not a Word (.docx) file: it is not a zip package.', [])
  }
  const main = files['word/document.xml']
  if (!main) throw new ToolError('UNREADABLE', 'This zip has no word/document.xml, so it is not a Word document.', [])
  const xml = strFromU8(main)
  const decl = /^<\?xml[^>]*\?>/.exec(xml)?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Opened['doc']
  const body = all(doc.documentElement, 'w:body')[0]
  if (!body) throw new ToolError('UNREADABLE', 'word/document.xml has no body.', [])
  return { files, decl, doc, body }
}

function close(o: Opened): Uint8Array {
  const xml = o.doc.toString().replace(/^<\?xml[^>]*\?>\s*/, '')
  o.files['word/document.xml'] = strToU8(`${o.decl}\n${xml}`)
  return zipSync(o.files, { level: 6 })
}

const bodyParagraphs = (o: Opened) => kids(o.body, 'w:p')
const tables = (o: Opened) => all(o.body, 'w:tbl')

/** Text nodes of a paragraph that belong to it (not to a nested paragraph). */
function texts(p: El): El[] {
  return all(p, 'w:t').filter((t) => {
    let n = t.parentNode
    while (n && n !== p) {
      if (n.tagName === 'w:p') return false
      if (n.tagName === 'w:del' || n.tagName === 'w:delText') return false
      n = n.parentNode
    }
    return true
  })
}

const paraText = (p: El) => texts(p).map((t) => t.textContent ?? '').join('')

/** Replace occurrences inside one paragraph, across runs. Returns how many. */
function replaceInParagraph(p: El, find: string, replace: string): number {
  const nodes = texts(p)
  if (!nodes.length) return 0
  let joined = nodes.map((t) => t.textContent ?? '').join('')
  if (!joined.includes(find)) return 0
  let n = 0
  let from = 0
  for (;;) {
    const at = joined.indexOf(find, from)
    if (at < 0) break
    // locate the nodes covering [at, at+find.length)
    let pos = 0
    let first = true
    let remaining = find.length
    for (const t of nodes) {
      const s = t.textContent ?? ''
      const start = pos
      const end = pos + s.length
      pos = end
      if (end <= at || remaining <= 0) continue
      const cut = Math.max(0, at - start)
      const take = Math.min(s.length - cut, remaining)
      const piece = s.slice(0, cut) + (first ? replace : '') + s.slice(cut + take)
      t.textContent = piece
      t.setAttribute('xml:space', 'preserve')
      remaining -= take
      first = false
    }
    joined = nodes.map((t) => t.textContent ?? '').join('')
    from = at + replace.length
    n++
  }
  return n
}

function setParagraphText(p: El, text: string): void {
  const nodes = texts(p)
  const lines = text.split(/\r?\n/)
  if (!nodes.length) {
    const r = p.ownerDocument.createElement('w:r')
    const t = p.ownerDocument.createElement('w:t')
    r.appendChild(t)
    p.appendChild(r)
    nodes.push(t)
  }
  nodes.forEach((t, k) => {
    t.textContent = k === 0 ? (lines[0] ?? '') : ''
    t.setAttribute('xml:space', 'preserve')
  })
  // further lines as breaks in the first run
  const run = nodes[0]!.parentNode!
  for (const line of lines.slice(1)) {
    run.appendChild(p.ownerDocument.createElement('w:br'))
    const t = p.ownerDocument.createElement('w:t')
    t.setAttribute('xml:space', 'preserve')
    t.textContent = line
    run.appendChild(t)
  }
}

interface GridCell {
  tc: El
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

/** Grid of a table: gridSpan for columns, vMerge for rows. */
function grid(tbl: El): { rows: number; cols: number; cells: GridCell[] } {
  const cells: GridCell[] = []
  const trs = kids(tbl, 'w:tr')
  let cols = 0
  const open: Record<number, GridCell> = {}
  trs.forEach((tr, r) => {
    let c = 0
    for (const tc of kids(tr, 'w:tc')) {
      const pr = kids(tc, 'w:tcPr')[0]
      const span = Number(pr && kids(pr, 'w:gridSpan')[0]?.getAttribute('w:val')) || 1
      const vm = pr && kids(pr, 'w:vMerge')[0]
      const vmVal = vm?.getAttribute('w:val')
      if (vm && vmVal !== 'restart' && open[c]) {
        open[c]!.rowSpan++
      } else {
        const cell = { tc, row: r, col: c, rowSpan: 1, colSpan: span }
        cells.push(cell)
        if (vm && vmVal === 'restart') for (let k = 0; k < span; k++) open[c + k] = cell
        else for (let k = 0; k < span; k++) delete open[c + k]
      }
      c += span
    }
    cols = Math.max(cols, c)
  })
  return { rows: trs.length, cols, cells }
}

const cellText = (tc: El) => kids(tc, 'w:p').map(paraText).join('\n')

export type DocxOp =
  | { op: 'replace_text'; find: string; replace: string }
  | { op: 'set_cell'; table: number; row: number; col: number; text: string }
  | { op: 'insert_paragraph'; paragraph: number; text: string }
  | { op: 'delete_paragraph'; paragraph: number }
  | { op: 'append_row'; table: number; cells: string[]; row?: number }

const short = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t).replace(/\n/g, ' / ')

function applyOne(o: Opened, op: DocxOp): { op: string; ok: boolean; changed: number; detail: string } {
  switch (op.op) {
    case 'replace_text': {
      if (!op.find) throw new ToolError('BAD_ARGUMENT', 'replace_text needs a non-empty find.', ['find'])
      let n = 0
      for (const p of all(o.body, 'w:p')) n += replaceInParagraph(p, op.find, op.replace ?? '')
      if (!n) throw new ToolError('NOT_APPLIED', `"${op.find}" was not found.`, [])
      return { op: op.op, ok: true, changed: n, detail: `${n} replaced` }
    }
    case 'set_cell': {
      const list = tables(o)
      const tbl = list[op.table]
      if (!tbl) throw new ToolError('BAD_ARGUMENT', `There is no table ${op.table}; this document has ${list.length} (0 to ${list.length - 1}).`, ['a table number from doc_inspect'])
      const g = grid(tbl)
      if (op.row < 0 || op.col < 0 || op.row >= g.rows || op.col >= g.cols) {
        throw new ToolError('BAD_ARGUMENT', `Table ${op.table} has ${g.rows} rows and ${g.cols} columns (from 0); row ${op.row}, col ${op.col} is outside.`, [])
      }
      const exact = g.cells.find((c) => c.row === op.row && c.col === op.col)
      if (!exact) {
        const cover = g.cells.find((c) => c.row <= op.row && op.row < c.row + c.rowSpan && c.col <= op.col && op.col < c.col + c.colSpan)
        throw new ToolError('RULE', cover ? `Row ${op.row}, col ${op.col} is covered by the merged cell at row ${cover.row}, col ${cover.col}. Write to that cell.` : `No cell at row ${op.row}, col ${op.col}.`, cover ? [`row ${cover.row}, col ${cover.col}`] : [])
      }
      if (all(exact.tc, 'w:tbl').length) throw new ToolError('RULE', 'This cell holds a table, which set_cell would remove. Use replace_text for the words in it.', [])
      const ps = kids(exact.tc, 'w:p')
      const before = cellText(exact.tc)
      ps.slice(1).forEach((p) => exact.tc.removeChild(p))
      setParagraphText(ps[0]!, op.text)
      return { op: op.op, ok: true, changed: 1, detail: `table ${op.table} row ${op.row} col ${op.col}: "${short(before)}" → "${short(op.text)}"` }
    }
    case 'insert_paragraph': {
      const ps = bodyParagraphs(o)
      const p = ps[op.paragraph]
      if (!p) throw new ToolError('BAD_ARGUMENT', `Body paragraphs are 0 to ${ps.length - 1}; ${op.paragraph} is outside.`, [])
      let after = p
      for (const line of (op.text ?? '').split(/\r?\n/)) {
        const copy = p.cloneNode(true)
        // keep paragraph properties and the first run's properties only
        for (const k of kids(copy)) if (k.tagName !== 'w:pPr' && k.tagName !== 'w:r') copy.removeChild(k)
        const runs = kids(copy, 'w:r')
        runs.slice(1).forEach((r) => copy.removeChild(r))
        if (runs[0]) for (const k of kids(runs[0])) if (k.tagName !== 'w:rPr') runs[0].removeChild(k)
        setParagraphText(copy, line)
        o.body.insertBefore(copy, after.nextSibling)
        after = copy
      }
      return { op: op.op, ok: true, changed: 1, detail: `after paragraph ${op.paragraph}` }
    }
    case 'delete_paragraph': {
      const ps = bodyParagraphs(o)
      const p = ps[op.paragraph]
      if (!p) throw new ToolError('BAD_ARGUMENT', `Body paragraphs are 0 to ${ps.length - 1}; ${op.paragraph} is outside.`, [])
      if (ps.length <= 1) throw new ToolError('RULE', 'The document must keep one paragraph.', [])
      if (all(p, 'w:sectPr').length) throw new ToolError('RULE', 'This paragraph carries the section settings (page size, margins); it cannot be deleted.', [])
      const text = paraText(p)
      o.body.removeChild(p)
      return { op: op.op, ok: true, changed: 1, detail: `deleted "${short(text)}"` }
    }
    case 'append_row': {
      const list = tables(o)
      const tbl = list[op.table]
      if (!tbl) throw new ToolError('BAD_ARGUMENT', `There is no table ${op.table}; this document has ${list.length}.`, [])
      const trs = kids(tbl, 'w:tr')
      const at = op.row ?? trs.length - 1
      const last = trs[at]
      if (!last) throw new ToolError('BAD_ARGUMENT', `Table ${op.table} has rows 0 to ${trs.length - 1}; ${at} is outside.`, [])
      const g = grid(tbl)
      if (g.cells.some((c) => c.row <= at && at < c.row + c.rowSpan && (c.rowSpan > 1 || c.colSpan > 1))) {
        const plain = trs.findIndex((_, r) => r > 0 && !g.cells.some((c) => c.row <= r && r < c.row + c.rowSpan && (c.rowSpan > 1 || c.colSpan > 1)))
        throw new ToolError('RULE', `Row ${at} of table ${op.table} has merged cells, so a copy of it is ambiguous.${plain >= 0 ? ` Row ${plain} has none: give row: ${plain}.` : ''}`, plain >= 0 ? [`row ${plain}`] : [], plain >= 0 ? { row: plain } : undefined)
      }
      const copy = last.cloneNode(true)
      for (const vm of all(copy, 'w:vMerge')) vm.parentNode?.removeChild(vm)
      kids(copy, 'w:tc').forEach((tc, k) => {
        const ps = kids(tc, 'w:p')
        ps.slice(1).forEach((p) => tc.removeChild(p))
        setParagraphText(ps[0]!, op.cells?.[k] ?? '')
      })
      tbl.insertBefore(copy, last.nextSibling)
      return { op: op.op, ok: true, changed: 1, detail: `row added under row ${at} of table ${op.table}` }
    }
    default:
      throw new ToolError('UNSUPPORTED', `Unknown op "${(op as { op: string }).op}" for DOCX. Ops: replace_text, set_cell, insert_paragraph, delete_paragraph, append_row.`, [])
  }
}

export async function editDocx(bytes: Uint8Array, ops: DocxOp[], dryRun: boolean) {
  const o = open(bytes)
  const results = []
  for (const [i, op] of ops.entries()) {
    try {
      results.push(applyOne(o, op))
    } catch (err) {
      if (err instanceof ToolError) throw new ToolError(err.code, `op ${i} (${op.op}): ${err.message}`, err.needs, { ...err.details, op: i, applied: results })
      throw err
    }
  }
  const tablesBefore = tables(open(bytes)).length
  const out = close(o)
  const verify = await verifyDocx(out, ops)
  return { bytes: dryRun ? null : out, results, verify: { ...verify, tablesBefore } }
}

async function verifyDocx(out: Uint8Array, ops: DocxOp[]) {
  const back = open(out)
  const text = (await mammoth.extractRawText({ buffer: Buffer.from(out) })).value
  const checks = ops.map((op, i) => {
    if (op.op === 'replace_text') {
      const left = op.replace?.includes(op.find) ? 0 : text.split(op.find).length - 1
      return { op: i, ok: left === 0, ...(left ? { why: `${left} left` } : {}) }
    }
    if (op.op === 'set_cell') {
      const g = grid(tables(back)[op.table]!)
      const c = g.cells.find((x) => x.row === op.row && x.col === op.col)
      const got = c ? cellText(c.tc) : ''
      const okc = got.replace(/\s+/g, '') === op.text.replace(/\s+/g, '')
      return { op: i, ok: okc, ...(okc ? {} : { why: `cell reads "${short(got)}"` }) }
    }
    if (op.op === 'insert_paragraph') return { op: i, ok: text.includes(op.text.split(/\r?\n/)[0]!) }
    if (op.op === 'append_row') return { op: i, ok: (op.cells ?? []).filter(Boolean).every((c) => text.includes(c)) }
    return { op: i, ok: true }
  })
  return { reopened: true, tables: tables(back).length, paragraphs: bodyParagraphs(back).length, characters: text.replace(/\s/g, '').length, checks, allConfirmed: checks.every((c) => c.ok) }
}

export function inspectDocx(bytes: Uint8Array) {
  const o = open(bytes)
  const ps = bodyParagraphs(o)
  const tbls = tables(o).map((t, k) => {
    const g = grid(t)
    let depth = 0
    for (let n = t.parentNode; n; n = n.parentNode) if (n.tagName === 'w:tbl') depth++
    return {
      table: k,
      rows: g.rows,
      cols: g.cols,
      merged: g.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).length,
      depth,
      preview: g.cells.slice(0, 4).map((c) => cellText(c.tc)).join(' | ').replace(/\s+/g, ' ').slice(0, 80),
    }
  })
  const styles = new Set<string>()
  for (const s of all(o.body, 'w:pStyle')) styles.add(s.getAttribute('w:val') ?? '')
  const text = all(o.body, 'w:p').map(paraText).join('\n')
  return {
    paragraphs: ps.length,
    tables: tbls,
    stylesUsed: [...styles].filter(Boolean),
    placeholders: [...new Set(text.match(/\{\{\s*[^{}]+?\s*\}\}/g) ?? [])],
    firstParagraphs: ps.slice(0, 60).map((p, k) => ({ paragraph: k, text: paraText(p).slice(0, 120) })).filter((x) => x.text.trim()),
    hasTrackedChanges: all(o.body, 'w:ins').length + all(o.body, 'w:del').length > 0,
    hasComments: Boolean(o.files['word/comments.xml']),
  }
}

export type TemplateValue = string | number | boolean | null | Record<string, string | number | boolean | null>[]

export async function fillDocxTemplate(bytes: Uint8Array, values: Record<string, TemplateValue>) {
  const o = open(bytes)
  const filled: Record<string, number> = {}
  let rowsAdded = 0
  for (const [name, value] of Object.entries(values)) {
    if (!Array.isArray(value)) continue
    const re = new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([^{}\\s]+)\\s*\\}\\}`, 'g')
    const probe = new RegExp(re.source)
    const row = all(o.body, 'w:tr').find((tr) => probe.test(kids(tr, 'w:tc').map(cellText).join('\n')))
    if (!row) {
      filled[name] = 0
      continue
    }
    for (const item of value) {
      const copy = row.cloneNode(true)
      for (const p of all(copy, 'w:p')) {
        const t = paraText(p)
        const fields = [...t.matchAll(re)]
        for (const m of fields) replaceInParagraph(p, m[0], str(item?.[m[1]!]))
      }
      row.parentNode!.insertBefore(copy, row)
    }
    row.parentNode!.removeChild(row)
    rowsAdded += value.length - 1
    filled[name] = value.length
  }
  for (const [name, value] of Object.entries(values)) {
    if (Array.isArray(value)) continue
    let n = 0
    for (const p of all(o.body, 'w:p')) {
      const t = paraText(p)
      const re = new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g')
      for (const m of [...new Set(t.match(re) ?? [])]) n += replaceInParagraph(p, m, str(value))
    }
    // headers and footers too
    for (const [path, data] of Object.entries(o.files)) {
      if (!/^word\/(header|footer)\d*\.xml$/.test(path)) continue
      let xml = strFromU8(data)
      const before = xml
      xml = xml.replace(new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), () => (n++, esc(str(value))))
      if (xml !== before) o.files[path] = strToU8(xml)
    }
    filled[name] = n
  }
  const out = close(o)
  const text = (await mammoth.extractRawText({ buffer: Buffer.from(out) })).value
  const left = [...new Set(text.match(/\{\{\s*[^{}]+?\s*\}\}/g) ?? [])]
  return { bytes: out, filled, rowsAdded, left, unused: Object.keys(filled).filter((k) => filled[k] === 0) }
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
