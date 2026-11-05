/**
 * The 0.6.0 tools that let an agent compose work on a document instead of
 * converting it away: look first (doc_inspect), change by op list (doc_edit),
 * fill a template (doc_create), look at the result (doc_render) and check it
 * (doc_check). Every result carries the numbers from reopening what was written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { hwpToPdf } from './convert'
import { openPdf, readTable } from './docs'
import { editDocx, fillDocxTemplate, inspectDocx, type DocxOp } from './docxEdit'
import { editHwp, fillHwpTemplate, inspectHwp, type HwpOp } from './hwpEdit'
import * as image from './image'
import { jtdToPdf } from './jtd'
import { renderPages } from './pdfx'
import { profileFor, profileUri } from './profiles'
import { absolutePath } from './paths'
import { ToolError, fail, ok, suffixedPath } from './result'
import { xdwToPdf } from './xdw'

type Server = { registerTool: (name: string, def: Record<string, unknown>, run: (args: never) => Promise<unknown>) => unknown }

const ext = (p: string) => extname(p).toLowerCase().replace(/^\./, '')
const read = (p: string) => new Uint8Array(readFileSync(p))
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'heif', 'bmp'])

function unsupported(kind: string, what: string): ToolError {
  const p = profileFor(kind)
  return new ToolError('UNSUPPORTED', `${what} is not available for .${kind}.${p ? ` See ${profileUri(kind)} for what is.` : ''}`, [])
}

/* ---------------------------------------------------------------- helpers */

/** Any document this server can draw, as a PDF (for doc_render and doc_check). */
async function asPdf(file: string, bytes: Uint8Array, kind: string, password?: string): Promise<{ pdf: Uint8Array; missing?: string[] }> {
  if (kind === 'pdf') return { pdf: bytes }
  if (kind === 'hwp' || kind === 'hwpx') {
    const r = await hwpToPdf(bytes, password)
    return { pdf: new Uint8Array(r.pdf), missing: r.stats.missingChars }
  }
  if (kind === 'jtd' || kind === 'jtt') return { pdf: new Uint8Array((await jtdToPdf(bytes, basename(file))).pdf) }
  if (kind === 'xdw' || kind === 'xbd') return { pdf: new Uint8Array((await xdwToPdf(bytes, basename(file))).pdf) }
  throw unsupported(kind, 'Drawing pages')
}

async function pdfFacts(bytes: Uint8Array, password?: string) {
  const task = await openPdf(bytes, password)
  const doc = await task.promise
  const pages: { page: number; width: number; height: number; characters: number; rotation: number }[] = []
  const fonts = new Set<string>()
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const text = (content.items as { str?: string; fontName?: string }[]).map((i) => i.str ?? '').join('')
    for (const s of Object.values((content as { styles?: Record<string, { fontFamily?: string }> }).styles ?? {})) if (s.fontFamily) fonts.add(s.fontFamily)
    pages.push({ page: n, width: Math.round(vp.width), height: Math.round(vp.height), characters: text.replace(/\s/g, '').length, rotation: page.rotate })
    page.cleanup()
  }
  let fields = 0
  try {
    fields = Object.keys((await doc.getFieldObjects()) ?? {}).length
  } catch {
    fields = 0
  }
  await task.destroy()
  return { pages, fonts: [...fonts], formFields: fields, scannedPages: pages.filter((p) => p.characters === 0).map((p) => p.page) }
}

const PLACEHOLDER = /\{\{\s*[^{}]+?\s*\}\}/g

/* ---------------------------------------------------------------- tools */

export function registerDocTools(server: Server): void {
  server.registerTool(
    'doc_inspect',
    {
      title: 'Inspect document',
      description:
        'Look before editing: what a document holds and how to address it. HWP/HWPX/DOCX: paragraphs, tables (number, rows, cols, merged cells), fields, {{placeholders}}. PDF: pages, sizes, text per page, scanned pages, fonts. Also XLSX/CSV sheets and images. Returns the format profile URI (ezpzfile://formats/<fmt>) with the edit ops and rules.',
      inputSchema: {
        path: z.string().describe('Absolute path'),
        password: z.string().optional(),
      },
    },
    async ({ path, password }: { path: string; password?: string }) => {
      try {
        const file = absolutePath(path)
        const bytes = read(file)
        const kind = ext(file)
        const profile = profileUri(kind)
        if (kind === 'hwp' || kind === 'hwpx') {
          const r = await inspectHwp(bytes, password)
          const lines = [
            `${r.pages} pages · ${r.sections.length} sections · ${r.tables.length} tables (${r.nestedTables} nested inside them) · ${r.mergedCells} merged cells · ${r.textBoxes} text boxes`,
            r.fields.length ? `fields: ${r.fields.map((f) => f.name || `(${f.type})`).join(', ')}` : null,
            r.placeholders.length ? `placeholders: ${r.placeholders.join(' ')}` : null,
            ...r.tables.slice(0, 30).map((t) => `table ${t.table}: ${t.rows}x${t.cols}${t.merged ? `, ${t.merged} merged` : ''}${t.nested ? `, ${t.nested} nested` : ''} (section ${t.section} paragraph ${t.paragraph}) ${t.preview}`),
            r.tables.length > 30 ? `… ${r.tables.length - 30} more tables in structuredContent` : null,
            `profile: ${profile}`,
          ].filter(Boolean)
          return ok(lines.join('\n'), { format: kind, profile, ...r, tables: r.tables.map(({ control: _c, ...t }) => t) })
        }
        if (kind === 'docx') {
          const r = inspectDocx(bytes)
          const lines = [
            `${r.paragraphs} body paragraphs · ${r.tables.length} tables${r.hasTrackedChanges ? ' · tracked changes' : ''}${r.hasComments ? ' · comments' : ''}`,
            r.placeholders.length ? `placeholders: ${r.placeholders.join(' ')}` : null,
            ...r.tables.slice(0, 30).map((t) => `table ${t.table}: ${t.rows}x${t.cols}${t.merged ? `, ${t.merged} merged` : ''}${t.depth ? `, inside another table` : ''} ${t.preview}`),
            `profile: ${profile}`,
          ].filter(Boolean)
          return ok(lines.join('\n'), { format: kind, profile, ...r })
        }
        if (kind === 'pdf') {
          const r = await pdfFacts(bytes, password)
          const sizes = [...new Set(r.pages.map((p) => `${p.width}x${p.height}`))]
          return ok(
            [
              `${r.pages.length} pages · sizes ${sizes.join(', ')} pt${r.scannedPages.length ? ` · no text layer on ${r.scannedPages.length} pages (${r.scannedPages.slice(0, 12).join(', ')})` : ''}${r.formFields ? ` · ${r.formFields} form fields` : ''}`,
              `profile: ${profile}`,
            ].join('\n'),
            { format: kind, profile, ...r },
          )
        }
        if (['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv'].includes(kind)) {
          const t = await readTable(bytes, basename(file))
          const sheets = t.sheets.map((s) => ({ name: (s as { name?: string }).name ?? '', rows: s.rows.length, cols: Math.max(0, ...s.rows.map((r) => r.length)) }))
          return ok(`${sheets.map((s) => `${s.name}: ${s.rows} rows x ${s.cols} cols`).join('\n')}\nprofile: ${profile}`, { format: kind, profile, sheets, encoding: t.encoding })
        }
        if (IMAGE.has(kind)) {
          const s = await image.probe(bytes)
          return ok(`${s.width}x${s.height} ${s.format}, ${s.bytes} bytes\nprofile: ${profile}`, { format: kind, profile, ...s })
        }
        if (profile) return ok(`Use doc_read for .${kind}. profile: ${profile}`, { format: kind, profile })
        throw unsupported(kind, 'doc_inspect')
      } catch (err) {
        return fail(err)
      }
    },
  )

  const opSchema = z
    .object({
      op: z.enum(['replace_text', 'set_cell', 'insert_paragraph', 'delete_paragraph', 'set_field', 'append_row']),
      find: z.string().optional(),
      replace: z.string().optional(),
      case_sensitive: z.boolean().optional(),
      table: z.number().int().nonnegative().optional(),
      row: z.number().int().nonnegative().optional(),
      col: z.number().int().nonnegative().optional(),
      section: z.number().int().nonnegative().optional(),
      paragraph: z.number().int().nonnegative().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
      cells: z.array(z.string()).optional(),
    })
    .passthrough()

  const NEEDS: Record<string, string[]> = {
    replace_text: ['find'],
    set_cell: ['table', 'row', 'col', 'text'],
    insert_paragraph: ['paragraph', 'text'],
    delete_paragraph: ['paragraph'],
    set_field: ['name', 'text'],
    append_row: ['table'],
  }

  server.registerTool(
    'doc_edit',
    {
      title: 'Edit document',
      description:
        'Change an HWP, HWPX or DOCX in place of its structure, by a list of ops applied in order: replace_text {find, replace}, set_cell {table,row,col,text}, insert_paragraph {paragraph,text}, delete_paragraph {paragraph}, set_field {name,text} (HWP), append_row {table, cells, row?} (copies row `row`, default the last, and puts it under). Addresses come from doc_inspect, counted from 0. A broken rule stops the run before anything is written (error RULE, see ezpzfile://formats/<fmt>). dry_run checks without writing. The output is reopened and each op confirmed. For PDF use pdf_edit.',
      inputSchema: {
        path: z.string().describe('Absolute path of the .hwp, .hwpx or .docx'),
        ops: z.array(opSchema).min(1).describe('Applied in order'),
        dry_run: z.boolean().optional().describe('Apply and check in memory, write nothing'),
        out: z.string().optional().describe('Absolute output path. Default: next to the source with -edited'),
        password: z.string().optional().describe('HWP/HWPX: password of an encrypted document; it is kept'),
      },
    },
    async ({ path, ops, dry_run, out, password }: { path: string; ops: Record<string, unknown>[]; dry_run?: boolean; out?: string; password?: string }) => {
      try {
        const file = absolutePath(path)
        const kind = ext(file)
        ops.forEach((o, i) => {
          const missing = (NEEDS[o.op as string] ?? []).filter((k) => o[k] === undefined)
          if (missing.length) throw new ToolError('BAD_ARGUMENT', `op ${i} (${o.op}) needs ${missing.join(', ')}.`, missing)
        })
        if (kind === 'pdf') throw new ToolError('UNSUPPORTED', 'For PDF use pdf_edit (replace_text, redact and page ops).', [])
        const bytes = read(file)
        let result: { bytes: Uint8Array | null; results: { op: string; detail: string; changed: number }[]; verify: Record<string, unknown> }
        if (kind === 'hwp' || kind === 'hwpx') result = await editHwp(bytes, kind, ops as unknown as HwpOp[], { password, dryRun: dry_run })
        else if (kind === 'docx') {
          if (ops.some((o) => o.op === 'set_field')) throw new ToolError('UNSUPPORTED', 'set_field is for HWP fields (누름틀). In DOCX use replace_text.', [])
          result = await editDocx(bytes, ops as unknown as DocxOp[], Boolean(dry_run))
        } else throw unsupported(kind, 'doc_edit')
        const target = suffixedPath(file, 'edited', kind, out)
        if (result.bytes) writeFileSync(target, result.bytes)
        const lines = [
          dry_run ? 'dry run: nothing written' : target,
          ...result.results.map((r, i) => `${i}. ${r.op}: ${r.detail}`),
          result.verify.allConfirmed ? 'reopened: every op confirmed' : `reopened: NOT all confirmed ${JSON.stringify((result.verify.checks as { ok: boolean }[]).filter((c) => !c.ok))}`,
        ]
        if (!dry_run && !result.verify.allConfirmed) {
          return fail(new ToolError('VERIFY_FAILED', lines.join('\n'), [], { path: target, verify: result.verify }))
        }
        return ok(lines.join('\n'), { path: dry_run ? null : target, dryRun: Boolean(dry_run), results: result.results, verify: result.verify })
      } catch (err) {
        return fail(err)
      }
    },
  )

  const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))])

  server.registerTool(
    'doc_create',
    {
      title: 'Create from template',
      description:
        'Make a new document from an HWP, HWPX or DOCX template by filling {{name}} placeholders. A list value fills a table: the row holding {{name.field}} is repeated once per item. Reports what was filled, placeholders left and values not used, after reopening the result.',
      inputSchema: {
        template: z.string().describe('Absolute path of the .hwp, .hwpx or .docx template'),
        values: z.record(z.string(), valueSchema).describe('{"name": "value", "items": [{"name": "...", "qty": 2}]}'),
        out: z.string().describe('Absolute output path (same extension as the template)'),
        password: z.string().optional(),
      },
    },
    async ({ template, values, out, password }: { template: string; values: Record<string, never>; out: string; password?: string }) => {
      try {
        const file = absolutePath(template, 'template')
        const kind = ext(file)
        const target = absolutePath(out, 'out')
        if (ext(target) !== kind) throw new ToolError('BAD_ARGUMENT', `out must end in .${kind} like the template. To get another format, convert the result with doc_convert.`, [`out ending in .${kind}`])
        const bytes = read(file)
        let r: { bytes: Uint8Array; filled: Record<string, number>; rowsAdded: number; left: string[]; unused: string[]; pages?: number }
        if (kind === 'hwp' || kind === 'hwpx') r = await fillHwpTemplate(bytes, kind, values, password)
        else if (kind === 'docx') r = await fillDocxTemplate(bytes, values)
        else throw unsupported(kind, 'doc_create')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, r.bytes)
        const lines = [
          target,
          `filled: ${Object.entries(r.filled).map(([k, n]) => `${k} ${n}`).join(', ')}${r.rowsAdded ? ` · ${r.rowsAdded} table rows added` : ''}`,
          r.left.length ? `placeholders left: ${r.left.join(' ')}` : 'reopened: no placeholders left',
          r.unused.length ? `values with no placeholder: ${r.unused.join(', ')}` : null,
        ].filter(Boolean)
        return ok(lines.join('\n'), { path: target, ...r, bytes: undefined, verify: { reopened: true, placeholdersLeft: r.left.length, pages: r.pages ?? null, allConfirmed: r.left.length === 0 && r.unused.length === 0 } })
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'doc_render',
    {
      title: 'Render pages',
      description: 'Draw pages of a PDF, HWP, HWPX, JTD or XDW as PNG images, to look at a layout or an edit. Pages are 1-based.',
      inputSchema: {
        path: z.string().describe('Absolute path'),
        pages: z.array(z.number().int().positive()).optional().describe('Default: page 1'),
        dpi: z.number().int().min(36).max(300).optional().describe('Default 110'),
        out: z.string().optional().describe('Absolute output directory. Default: a folder next to the file'),
        password: z.string().optional(),
      },
    },
    async ({ path, pages, dpi, out, password }: { path: string; pages?: number[]; dpi?: number; out?: string; password?: string }) => {
      try {
        const file = absolutePath(path)
        const kind = ext(file)
        const { pdf } = await asPdf(file, read(file), kind, password)
        const rendered = await renderPages(pdf, { pages: pages ?? [1], dpi: dpi ?? 110, format: 'png', password: kind === 'pdf' ? password : undefined })
        if (!rendered.length) throw new ToolError('BAD_ARGUMENT', 'None of those pages exist.', [])
        const dir = out ? absolutePath(out, 'out') : join(dirname(file), `${basename(file, extname(file))}-pages`)
        mkdirSync(dir, { recursive: true })
        const files = rendered.map((r) => {
          const p = join(dir, `page-${r.page}.png`)
          writeFileSync(p, r.bytes)
          return { path: p, page: r.page, width: r.width, height: r.height }
        })
        return ok(files.map((f) => `${f.path} (${f.width}x${f.height})`).join('\n'), { files })
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'doc_check',
    {
      title: 'Check document',
      description:
        'Check a finished document before sending it: does it open, page count, empty pages, characters no font can draw (HWP), {{placeholders}} or empty fields left, pages without a text layer (PDF), phrases that must not appear (forbid). Returns issues with severity.',
      inputSchema: {
        path: z.string().describe('Absolute path'),
        forbid: z.array(z.string()).optional().describe('Phrases that must not be anywhere in the text, e.g. names that were redacted'),
        expect_pages: z.number().int().positive().optional(),
        password: z.string().optional(),
      },
    },
    async ({ path, forbid, expect_pages, password }: { path: string; forbid?: string[]; expect_pages?: number; password?: string }) => {
      try {
        const file = absolutePath(path)
        const kind = ext(file)
        const bytes = read(file)
        const issues: { severity: 'error' | 'warning' | 'info'; code: string; message: string }[] = []
        let text = ''
        let pages = 0
        if (kind === 'hwp' || kind === 'hwpx') {
          const r = await inspectHwp(bytes, password)
          pages = r.pages
          const { readDocument } = await import('./convert')
          text = (await readDocument(bytes, password, 'text')).text
          const empty = r.fields.filter((f) => f.type !== 'hyperlink' && f.name && !f.value)
          if (empty.length) issues.push({ severity: 'warning', code: 'EMPTY_FIELDS', message: `empty fields: ${empty.map((f) => f.name).join(', ')}` })
          const pdf = await hwpToPdf(bytes, password)
          if (pdf.stats.missingGlyphs) issues.push({ severity: 'warning', code: 'MISSING_GLYPHS', message: `${pdf.stats.missingGlyphs} characters no font here can draw: ${(pdf.stats.missingChars ?? []).join(', ')}` })
          const facts = await pdfFacts(new Uint8Array(pdf.pdf))
          const blank = facts.pages.filter((p) => p.characters === 0).map((p) => p.page)
          if (blank.length) issues.push({ severity: 'info', code: 'PAGES_WITHOUT_TEXT', message: `pages with no text (pictures only or blank): ${blank.join(', ')}` })
        } else if (kind === 'docx') {
          const mammoth = (await import('mammoth')).default
          text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value
          const r = inspectDocx(bytes)
          if (r.hasTrackedChanges) issues.push({ severity: 'warning', code: 'TRACKED_CHANGES', message: 'the document still has tracked changes' })
          if (r.hasComments) issues.push({ severity: 'warning', code: 'COMMENTS', message: 'the document has comments' })
        } else if (kind === 'pdf') {
          const facts = await pdfFacts(bytes, password)
          pages = facts.pages.length
          const task = await openPdf(bytes, password)
          const doc = await task.promise
          const parts: string[] = []
          for (let n = 1; n <= doc.numPages; n++) parts.push(((await (await doc.getPage(n)).getTextContent()).items as { str?: string }[]).map((i) => i.str ?? '').join(''))
          await task.destroy()
          text = parts.join('\n')
          if (facts.scannedPages.length) issues.push({ severity: 'info', code: 'NO_TEXT_LAYER', message: `no text layer on pages ${facts.scannedPages.join(', ')} (scans or redacted pages): forbid cannot see into them` })
        } else if (kind === 'jtd' || kind === 'jtt' || kind === 'xdw' || kind === 'xbd') {
          const r = await asPdf(file, bytes, kind)
          const facts = await pdfFacts(r.pdf)
          pages = facts.pages.length
        } else throw unsupported(kind, 'doc_check')
        const left = [...new Set(text.match(PLACEHOLDER) ?? [])]
        if (left.length) issues.push({ severity: 'error', code: 'PLACEHOLDERS_LEFT', message: `placeholders not filled: ${left.join(' ')}` })
        for (const f of forbid ?? []) {
          const n = text.split(f).length - 1
          if (n) issues.push({ severity: 'error', code: 'FORBIDDEN_TEXT', message: `"${f}" appears ${n} times` })
        }
        if (expect_pages && pages && pages !== expect_pages) issues.push({ severity: 'error', code: 'PAGE_COUNT', message: `${pages} pages, expected ${expect_pages}` })
        const errors = issues.filter((i) => i.severity === 'error').length
        const summary = [`${errors ? 'FAILED' : 'passed'}: opens${pages ? `, ${pages} pages` : ''}, ${issues.length} issues`, ...issues.map((i) => `${i.severity} ${i.code}: ${i.message}`)].join('\n')
        return ok(summary, { passed: errors === 0, pages, issues })
      } catch (err) {
        return fail(err)
      }
    },
  )
}
