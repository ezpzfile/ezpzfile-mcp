/**
 * HWP·HWPX: inspect, edit by op list, fill templates. Everything goes through the
 * rhwp engine's own edit calls (the ones the HWP editor on ezpzfile.com uses), and
 * every written file is reopened and checked against what was asked.
 *
 * Addresses (ezpzfile://formats/hwp):
 *   paragraph {section, paragraph}  body paragraphs, from 0
 *   table     {table}               top-level body tables in reading order, from 0
 *   cell      {table, row, col}     from 0; a merged cell by its top-left cell
 */
import { HwpDocError, freeDoc, openDocument, withEngine, type HwpDocument } from './engine'
import { parseHwpx, plain, type HwpBlock, type HwpStructure, type HwpTable } from './hwpStructure'
import { ToolError } from './result'

export interface TableRef {
  table: number
  section: number
  paragraph: number
  control: number
  rows: number
  cols: number
  cells: number
  merged: number
  /** tables inside its cells (not addressable by doc_edit) */
  nested: number
  preview: string
}

interface CellRef {
  index: number
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

const j = <T>(s: string): T => JSON.parse(s) as T

/** Top-level body tables, in reading order, with the engine's own coordinates. */
export function listTables(doc: HwpDocument, structure?: HwpStructure): TableRef[] {
  const top: HwpTable[] = []
  if (structure) {
    const walk = (blocks: HwpBlock[]) => {
      for (const b of blocks) {
        if (b.kind === 'table') top.push(b)
        else if (b.kind === 'textbox') continue
      }
    }
    for (const sec of structure.sections) walk(sec)
  }
  const out: TableRef[] = []
  const sections = doc.getSectionCount()
  for (let s = 0; s < sections; s++) {
    const paragraphs = doc.getParagraphCount(s)
    for (let p = 0; p < paragraphs; p++) {
      let positions: number[]
      try {
        positions = j<number[]>(doc.getControlTextPositions(s, p))
      } catch {
        continue
      }
      for (let c = 0; c < positions.length; c++) {
        let dims: { rowCount: number; colCount: number; cellCount: number }
        try {
          dims = j(doc.getTableDimensions(s, p, c))
        } catch {
          continue // not a table
        }
        const t = top[out.length]
        out.push({
          table: out.length,
          section: s,
          paragraph: p,
          control: c,
          rows: dims.rowCount,
          cols: dims.colCount,
          cells: dims.cellCount,
          merged: t ? t.cells.filter((x) => x.rowSpan > 1 || x.colSpan > 1).length : 0,
          nested: t ? t.cells.reduce((n, x) => n + x.blocks.filter((b) => b.kind === 'table').length, 0) : 0,
          preview: t ? plain(t.cells.slice(0, 4).flatMap((x) => x.blocks)).replace(/\s+/g, ' ').trim().slice(0, 80) : '',
        })
      }
    }
  }
  return out
}

function cellsOf(doc: HwpDocument, t: TableRef): CellRef[] {
  const out: CellRef[] = []
  for (let k = 0; k < t.cells; k++) {
    const info = j<{ row: number; col: number; rowSpan: number; colSpan: number }>(doc.getCellInfo(t.section, t.paragraph, t.control, k))
    out.push({ index: k, ...info })
  }
  return out
}

function findCell(doc: HwpDocument, t: TableRef, row: number, col: number): CellRef {
  if (row < 0 || col < 0 || row >= t.rows || col >= t.cols) {
    throw new ToolError('BAD_ARGUMENT', `Table ${t.table} has ${t.rows} rows and ${t.cols} columns (counted from 0); row ${row}, col ${col} is outside it.`, ['row and col inside the table'])
  }
  const cells = cellsOf(doc, t)
  const exact = cells.find((c) => c.row === row && c.col === col)
  if (exact) return exact
  const cover = cells.find((c) => c.row <= row && row < c.row + c.rowSpan && c.col <= col && col < c.col + c.colSpan)
  if (cover) {
    throw new ToolError('RULE', `Row ${row}, col ${col} of table ${t.table} is covered by the merged cell at row ${cover.row}, col ${cover.col}. Write to that cell.`, [`row ${cover.row}, col ${cover.col}`], { anchor: { row: cover.row, col: cover.col } })
  }
  throw new ToolError('BAD_ARGUMENT', `Table ${t.table} has no cell at row ${row}, col ${col}.`, [])
}

function cellText(doc: HwpDocument, t: TableRef, cell: number): string {
  const n = doc.getCellParagraphCount(t.section, t.paragraph, t.control, cell)
  const lines: string[] = []
  for (let k = 0; k < n; k++) {
    const len = doc.getCellParagraphLength(t.section, t.paragraph, t.control, cell, k)
    lines.push(doc.getTextInCell(t.section, t.paragraph, t.control, cell, k, 0, len))
  }
  return lines.join('\n')
}

function setCellText(doc: HwpDocument, t: TableRef, cell: number, text: string): void {
  const { section: s, paragraph: p, control: c } = t
  let n = doc.getCellParagraphCount(s, p, c, cell)
  for (let k = n - 1; k >= 1; k--) doc.mergeParagraphInCell(s, p, c, cell, k)
  n = doc.getCellParagraphCount(s, p, c, cell)
  const len = doc.getCellParagraphLength(s, p, c, cell, 0)
  if (len > 0) doc.deleteTextInCell(s, p, c, cell, 0, 0, len)
  const lines = text.split(/\r?\n/)
  doc.insertTextInCell(s, p, c, cell, 0, 0, lines[0] ?? '')
  for (let k = 1; k < lines.length; k++) {
    const end = doc.getCellParagraphLength(s, p, c, cell, k - 1)
    doc.splitParagraphInCell(s, p, c, cell, k - 1, end)
    doc.insertTextInCell(s, p, c, cell, k, 0, lines[k] ?? '')
  }
}

/** All text of the document, cells and text boxes included, for counting what changed. */
function allText(doc: HwpDocument): string {
  const s = parseHwpx(doc.exportHwpx())
  return s.sections.map((sec) => plain(sec)).join('\n') + '\n' + s.footnotes.join('\n')
}

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0)

export type HwpOp =
  | { op: 'replace_text'; find: string; replace: string; case_sensitive?: boolean }
  | { op: 'set_cell'; table: number; row: number; col: number; text: string }
  | { op: 'insert_paragraph'; section?: number; paragraph: number; text: string }
  | { op: 'delete_paragraph'; section?: number; paragraph: number }
  | { op: 'set_field'; name: string; text: string }
  | { op: 'append_row'; table: number; cells: string[]; row?: number }

export interface OpResult {
  op: string
  ok: boolean
  changed: number
  detail: string
}

function tableAt(tables: TableRef[], n: number): TableRef {
  const t = tables[n]
  if (!t) throw new ToolError('BAD_ARGUMENT', `There is no table ${n}. This document has ${tables.length} top-level tables (0 to ${tables.length - 1}); doc_inspect lists them.`, ['a table number from doc_inspect'])
  if (t.nested > 0) {
    // nested tables are fine to keep, but set_cell would merge their paragraphs away
  }
  return t
}

function applyOne(doc: HwpDocument, op: HwpOp, structure: () => HwpStructure): OpResult {
  switch (op.op) {
    case 'replace_text': {
      if (!op.find) throw new ToolError('BAD_ARGUMENT', 'replace_text needs a non-empty find.', ['find'])
      const r = j<{ ok: boolean; count: number }>(doc.replaceAll(op.find, op.replace ?? '', op.case_sensitive ?? true))
      const nested = op.case_sensitive === false ? 0 : replaceNested(doc, op.find, op.replace ?? '', structure())
      const total = r.count + nested
      if (!total) throw new ToolError('NOT_APPLIED', `"${op.find}" was not found.`, [])
      return { op: op.op, ok: true, changed: total, detail: `${total} replaced${nested ? ` (${nested} in tables inside tables)` : ''}` }
    }
    case 'set_cell': {
      const tables = listTables(doc, structure())
      const t = tableAt(tables, op.table)
      const cell = findCell(doc, t, op.row, op.col)
      const st = structure()
      const top = topTables(st)[op.table]
      const sc = top?.cells.find((x) => x.row === cell.row && x.col === cell.col)
      if (sc && sc.blocks.some((b) => b.kind !== 'paragraph')) {
        throw new ToolError('RULE', `The cell at row ${op.row}, col ${op.col} of table ${op.table} holds a table or text box, which set_cell would remove. Use replace_text for the words in it.`, [])
      }
      const before = cellText(doc, t, cell.index)
      setCellText(doc, t, cell.index, op.text)
      return { op: op.op, ok: true, changed: 1, detail: `table ${op.table} row ${op.row} col ${op.col}: "${short(before)}" → "${short(op.text)}"` }
    }
    case 'insert_paragraph': {
      const s = op.section ?? 0
      checkPara(doc, s, op.paragraph)
      const len = doc.getParagraphLength(s, op.paragraph)
      doc.splitParagraph(s, op.paragraph, len)
      const lines = (op.text ?? '').split(/\r?\n/)
      doc.insertText(s, op.paragraph + 1, 0, lines[0] ?? '')
      for (let k = 1; k < lines.length; k++) {
        const at = op.paragraph + k
        doc.splitParagraph(s, at, doc.getParagraphLength(s, at))
        doc.insertText(s, at + 1, 0, lines[k] ?? '')
      }
      return { op: op.op, ok: true, changed: lines.length, detail: `after section ${s} paragraph ${op.paragraph}` }
    }
    case 'delete_paragraph': {
      const s = op.section ?? 0
      checkPara(doc, s, op.paragraph)
      const controls = j<number[]>(doc.getControlTextPositions(s, op.paragraph))
      if (controls.length) {
        throw new ToolError('RULE', `Section ${s} paragraph ${op.paragraph} holds a table, picture or other object; delete_paragraph only removes text paragraphs.`, [])
      }
      if (doc.getParagraphCount(s) <= 1) throw new ToolError('RULE', 'A section must keep at least one paragraph.', [])
      const text = doc.getTextRange(s, op.paragraph, 0, doc.getParagraphLength(s, op.paragraph))
      doc.deleteParagraph(s, op.paragraph)
      return { op: op.op, ok: true, changed: 1, detail: `deleted "${short(text)}"` }
    }
    case 'set_field': {
      let r: { ok?: boolean; oldValue?: string }
      try {
        r = j(doc.setFieldValueByName(op.name, op.text))
      } catch (err) {
        const names = j<{ name: string; fieldType: string }[]>(doc.getFieldList()).filter((f) => f.name).map((f) => f.name)
        throw new ToolError('BAD_ARGUMENT', `No field named "${op.name}". ${names.length ? `Fields: ${[...new Set(names)].join(', ')}` : 'This document has no named fields.'}`, ['a field name from doc_inspect'])
      }
      return { op: op.op, ok: r.ok !== false, changed: 1, detail: `${op.name}: "${short(r.oldValue ?? '')}" → "${short(op.text)}"` }
    }
    case 'append_row': {
      const tables = listTables(doc, structure())
      const t = tableAt(tables, op.table)
      const cells = cellsOf(doc, t)
      const last = op.row ?? t.rows - 1
      if (last < 0 || last >= t.rows) throw new ToolError('BAD_ARGUMENT', `Table ${op.table} has rows 0 to ${t.rows - 1}; ${last} is outside.`, [])
      const mergedIn = (r: number) => cells.some((c) => c.row <= r && r < c.row + c.rowSpan && (c.rowSpan > 1 || c.colSpan > 1))
      if (mergedIn(last)) {
        const plain = Array.from({ length: t.rows }, (_, r) => r).find((r) => r > 0 && !mergedIn(r))
        throw new ToolError('RULE', `Row ${last} of table ${op.table} has merged cells, so a copy of it is ambiguous.${plain !== undefined ? ` Row ${plain} has none: give row: ${plain}.` : ''}`, plain !== undefined ? [`row ${plain}`] : [], plain !== undefined ? { row: plain } : undefined)
      }
      doc.insertTableRow(t.section, t.paragraph, t.control, last, true)
      const fresh = { ...t, rows: t.rows + 1, cells: j<{ cellCount: number }>(doc.getTableDimensions(t.section, t.paragraph, t.control)).cellCount }
      const row = cellsOf(doc, fresh).filter((c) => c.row === last + 1).sort((a, b) => a.col - b.col)
      row.forEach((c, k) => setCellText(doc, fresh, c.index, op.cells?.[k] ?? ''))
      return { op: op.op, ok: true, changed: 1, detail: `row added under row ${last} of table ${op.table}` }
    }
    default:
      throw new ToolError('UNSUPPORTED', `Unknown op "${(op as { op: string }).op}" for HWP. Ops: replace_text, set_cell, insert_paragraph, delete_paragraph, set_field, append_row.`, [])
  }
}

type PathStep = { controlIndex: number; cellIndex: number; cellParaIndex: number }

/**
 * Replace inside tables that sit in a table cell, which replaceAll does not reach.
 * The engine addresses them by a path of {controlIndex, cellIndex, cellParaIndex}
 * steps; we find the steps by trying the positions the structure says hold a table.
 */
function replaceNested(doc: HwpDocument, find: string, replace: string, structure: HwpStructure): number {
  const tables = listTables(doc, structure)
  const tops = topTables(structure)
  let n = 0
  const tryCount = (t: TableRef, path: PathStep[]) => {
    try {
      return doc.getCellParagraphCountByPath(t.section, t.paragraph, JSON.stringify(path))
    } catch {
      return -1
    }
  }
  tables.forEach((t, ti) => {
    const top = tops[ti]
    if (!top || !t.nested) return
    const cells = cellsOf(doc, t)
    for (const sc of top.cells) {
      const inner = sc.blocks.filter((b): b is HwpTable => b.kind === 'table')
      if (!inner.length) continue
      const cell = cells.find((c) => c.row === sc.row && c.col === sc.col)
      if (!cell) continue
      const paras = doc.getCellParagraphCount(t.section, t.paragraph, t.control, cell.index)
      for (let q = 0; q < paras; q++) {
        for (let ci = 0; ci < 4; ci++) {
          for (let k = 0; k < 400; k++) {
            const base: PathStep[] = [{ controlIndex: t.control, cellIndex: cell.index, cellParaIndex: q }]
            const probe = [...base, { controlIndex: ci, cellIndex: k, cellParaIndex: 0 }]
            const count = tryCount(t, probe)
            if (count < 0) break
            for (let r = 0; r < count; r++) {
              const path = JSON.stringify([...base, { controlIndex: ci, cellIndex: k, cellParaIndex: r }])
              for (let guard = 0; guard < 100; guard++) {
                const len = doc.getCellParagraphLengthByPath(t.section, t.paragraph, path)
                const text = doc.getTextInCellByPath(t.section, t.paragraph, path, 0, len)
                const at = text.indexOf(find)
                if (at < 0) break
                doc.deleteTextInCellByPath(t.section, t.paragraph, path, at, find.length)
                if (replace) doc.insertTextInCellByPath(t.section, t.paragraph, path, at, replace)
                n++
                if (replace.includes(find)) break
              }
            }
          }
        }
      }
    }
  })
  return n
}

function topTables(s: HwpStructure): HwpTable[] {
  return s.sections.flatMap((sec) => sec.filter((b): b is HwpTable => b.kind === 'table'))
}

function checkPara(doc: HwpDocument, s: number, p: number): void {
  const sections = doc.getSectionCount()
  if (s < 0 || s >= sections) throw new ToolError('BAD_ARGUMENT', `There is no section ${s}; this document has ${sections}.`, [])
  const n = doc.getParagraphCount(s)
  if (p < 0 || p >= n) throw new ToolError('BAD_ARGUMENT', `Section ${s} has paragraphs 0 to ${n - 1}; ${p} is outside.`, [])
}

const short = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t).replace(/\n/g, ' / ')

function save(doc: HwpDocument, kind: 'hwp' | 'hwpx', password?: string): Uint8Array {
  if (kind === 'hwpx') return password ? doc.exportHwpxWithPassword(password) : doc.exportHwpx()
  return password ? doc.exportHwpWithPassword(password) : doc.exportHwp()
}

export interface EditOutcome {
  bytes: Uint8Array | null
  results: OpResult[]
  verify: Record<string, unknown>
}

/**
 * Apply `ops` in order. One failing op stops the run and nothing is written; the
 * error says which op it was. With dryRun the edits are made in memory, checked,
 * and thrown away.
 */
export async function editHwp(bytes: Uint8Array, kind: 'hwp' | 'hwpx', ops: HwpOp[], opts: { password?: string; dryRun?: boolean }): Promise<EditOutcome> {
  return withEngine((engine) => {
    const doc = openDocument(engine, bytes, opts.password)
    let back: HwpDocument | null = null
    try {
      const pagesBefore = doc.pageCount()
      let cache: HwpStructure | null = null
      const structure = () => (cache ??= parseHwpx(doc.exportHwpx()))
      const results: OpResult[] = []
      for (const [i, op] of ops.entries()) {
        try {
          results.push(applyOne(doc, op, structure))
        } catch (err) {
          if (err instanceof ToolError) {
            throw new ToolError(err.code, `op ${i} (${op.op}): ${err.message}`, err.needs, { ...err.details, op: i, applied: results })
          }
          throw err
        }
        cache = null
      }
      const out = save(doc, kind, opts.password)
      // Reopen what was written and look for what each op promised.
      back = new engine.HwpDocument(out)
      if (opts.password) {
        try {
          back.free()
        } catch {
          /* already freed */
        }
        back = openDocument(engine, out, opts.password)
      }
      const text = allText(back)
      const checks: { op: number; ok: boolean; why?: string }[] = []
      const tablesBack = listTables(back, parseHwpx(back.exportHwpx()))
      ops.forEach((op, i) => {
        if (op.op === 'replace_text') {
          const left = op.replace?.includes(op.find) ? 0 : count(text, op.find)
          checks.push({ op: i, ok: left === 0, ...(left ? { why: `${left} "${op.find}" still in the file` } : {}) })
        } else if (op.op === 'set_cell') {
          const t = tablesBack[op.table]
          let got = ''
          try {
            const c = t && cellsOf(back!, t).find((x) => x.row === op.row && x.col === op.col)
            got = t && c ? cellText(back!, t, c.index) : ''
          } catch {
            got = ''
          }
          const okCell = got.replace(/\s+/g, '') === op.text.replace(/\s+/g, '')
          checks.push({ op: i, ok: okCell, ...(okCell ? {} : { why: `cell reads "${short(got)}"` }) })
        } else if (op.op === 'insert_paragraph' || op.op === 'set_field' || op.op === 'append_row') {
          const want = op.op === 'append_row' ? (op.cells ?? []).filter(Boolean) : [op.text]
          const missing = want.filter((w) => w && !text.includes(w.split(/\r?\n/)[0]!))
          checks.push({ op: i, ok: missing.length === 0, ...(missing.length ? { why: `not found after reopening: ${missing.map(short).join(', ')}` } : {}) })
        } else {
          checks.push({ op: i, ok: true })
        }
      })
      const verify = {
        reopened: true,
        pagesBefore,
        pagesAfter: back.pageCount(),
        tables: tablesBack.length,
        checks,
        allConfirmed: checks.every((c) => c.ok),
      }
      return { bytes: opts.dryRun ? null : out, results, verify }
    } finally {
      freeDoc(back)
      freeDoc(doc)
    }
  })
}

/* ------------------------------------------------------------------ inspect */

export interface HwpInspect {
  pages: number
  sections: { section: number; paragraphs: number }[]
  tables: TableRef[]
  nestedTables: number
  textBoxes: number
  mergedCells: number
  fields: { name: string; type: string; value: string }[]
  placeholders: string[]
  outline: string[]
  fontsUsed: string[]
  encrypted: boolean
  firstParagraphs: { section: number; paragraph: number; text: string }[]
}

export async function inspectHwp(bytes: Uint8Array, password?: string): Promise<HwpInspect> {
  return withEngine((engine) => {
    const doc = openDocument(engine, bytes, password)
    try {
      const s = parseHwpx(doc.exportHwpx())
      const info = j<{ fontsUsed?: string[]; encrypted?: boolean }>(doc.getDocumentInfo())
      const sections = Array.from({ length: doc.getSectionCount() }, (_, k) => ({ section: k, paragraphs: doc.getParagraphCount(k) }))
      const firstParagraphs: HwpInspect['firstParagraphs'] = []
      for (const sec of sections) {
        for (let p = 0; p < sec.paragraphs && firstParagraphs.length < 40; p++) {
          const len = doc.getParagraphLength(sec.section, p)
          const text = len ? doc.getTextRange(sec.section, p, 0, Math.min(len, 120)).replace(/[\u0000-\u001f]/g, ' ').trim() : ''
          if (text) firstParagraphs.push({ section: sec.section, paragraph: p, text })
        }
      }
      let fields: HwpInspect['fields'] = []
      try {
        fields = j<{ name: string; fieldType: string; value: string }[]>(doc.getFieldList())
          .filter((f) => f.fieldType !== 'hyperlink')
          .map((f) => ({ name: f.name, type: f.fieldType, value: f.value }))
      } catch {
        fields = []
      }
      const all = s.sections.map((x) => plain(x)).join('\n')
      let outline: string[] = []
      try {
        const st = j<{ preamble?: string[]; nodes?: { title?: string }[] }>(doc.getStructure('auto'))
        outline = (st.nodes ?? []).map((n) => n.title ?? '').filter(Boolean).slice(0, 40)
      } catch {
        outline = []
      }
      return {
        pages: doc.pageCount(),
        sections,
        tables: listTables(doc, s),
        nestedTables: s.stats.nestedTables,
        textBoxes: s.stats.textBoxes,
        mergedCells: s.stats.mergedCells,
        fields,
        placeholders: [...new Set(all.match(/\{\{\s*[^{}]+?\s*\}\}/g) ?? [])],
        outline,
        fontsUsed: info.fontsUsed ?? [],
        encrypted: Boolean(info.encrypted),
        firstParagraphs,
      }
    } finally {
      freeDoc(doc)
    }
  })
}

/* ------------------------------------------------------------------ templates */

export type TemplateValue = string | number | boolean | null | Record<string, string | number | boolean | null>[]

/**
 * Fill {{name}} placeholders. A list value fills a table row: the row whose cells hold
 * {{name.field}} is repeated once per item (rows are added under it).
 */
export async function fillHwpTemplate(
  bytes: Uint8Array,
  kind: 'hwp' | 'hwpx',
  values: Record<string, TemplateValue>,
  password?: string,
): Promise<{ bytes: Uint8Array; filled: Record<string, number>; rowsAdded: number; left: string[]; unused: string[]; pages: number }> {
  return withEngine((engine) => {
    const doc = openDocument(engine, bytes, password)
    let back: HwpDocument | null = null
    try {
      const filled: Record<string, number> = {}
      let rowsAdded = 0
      // lists first: repeat rows
      for (const [name, value] of Object.entries(values)) {
        if (!Array.isArray(value)) continue
        const s = parseHwpx(doc.exportHwpx())
        const tops = topTables(s)
        const tables = listTables(doc, s)
        const pattern = new RegExp(`\\{\\{\\s*${escapeRe(name)}\\.([^{}\\s]+)\\s*\\}\\}`)
        let done = false
        for (const [ti, t] of tops.entries()) {
          const rowCells = t.cells.filter((c) => pattern.test(plain(c.blocks)))
          if (!rowCells.length) continue
          const row = rowCells[0]!.row
          const ref = tables[ti]!
          const templateRow = t.cells.filter((c) => c.row === row).sort((a, b) => a.col - b.col)
          const texts = templateRow.map((c) => plain(c.blocks))
          for (let k = 1; k < value.length; k++) doc.insertTableRow(ref.section, ref.paragraph, ref.control, row, true)
          rowsAdded += Math.max(0, value.length - 1)
          const fresh = { ...ref, cells: j<{ cellCount: number }>(doc.getTableDimensions(ref.section, ref.paragraph, ref.control)).cellCount, rows: ref.rows + Math.max(0, value.length - 1) }
          const cells = cellsOf(doc, fresh)
          value.forEach((item, k) => {
            templateRow.forEach((tc, ci) => {
              const target = cells.find((c) => c.row === row + k && c.col === tc.col)
              if (!target) return
              const text = texts[ci]!.replace(new RegExp(pattern.source, 'g'), (_, field: string) => str(item?.[field]))
              setCellText(doc, fresh, target.index, text)
            })
          })
          if (value.length === 0) {
            // no items: empty the template row
            templateRow.forEach((tc) => {
              const target = cells.find((c) => c.row === row && c.col === tc.col)
              if (target) setCellText(doc, fresh, target.index, '')
            })
          }
          filled[name] = value.length
          done = true
          break
        }
        if (!done) filled[name] = 0
      }
      for (const [name, value] of Object.entries(values)) {
        if (Array.isArray(value)) continue
        let n = 0
        for (const form of [`{{${name}}}`, `{{ ${name} }}`]) {
          const r = j<{ count: number }>(doc.replaceAll(form, str(value).replace(/\r?\n/g, ' '), true))
          n += r.count
        }
        filled[name] = n
      }
      const out = save(doc, kind, password)
      back = openDocument(engine, out, password)
      const text = allText(back)
      const left = [...new Set(text.match(/\{\{\s*[^{}]+?\s*\}\}/g) ?? [])]
      return { bytes: out, filled, rowsAdded, left, unused: Object.keys(filled).filter((k) => filled[k] === 0), pages: back.pageCount() }
    } finally {
      freeDoc(back)
      freeDoc(doc)
    }
  })
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export { HwpDocError }
