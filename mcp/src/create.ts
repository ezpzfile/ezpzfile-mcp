/**
 * doc_create: one template, one or many filled copies.
 *
 * A template marks what changes either with {{name}} placeholders, or (literal) with
 * the sample text the designer left in it ("홍길동", "010-0000-0000"). Formats:
 * HWP, HWPX, DOCX (placeholders and repeating table rows), PDF (text rewritten where
 * the page draws it, font kept) and SVG (text nodes).
 *
 * Many copies come from `rows` or a CSV/XLSX `data` file, one file per row, named by a
 * pattern like "card-{{name}}". Every copy is reopened and checked; a failed row is
 * reported and the others still get made.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { designKind, fillDesign } from './designTools'
import { basename, extname, join } from 'node:path'
import { readPdfPages } from './docs'
import { editDocx, fillDocxTemplate, type DocxOp } from './docxEdit'
import { editHwp, fillHwpTemplate, type HwpOp } from './hwpEdit'
import { replaceMany } from './pdfText'
import { ToolError } from './result'

export type Scalar = string | number | boolean | null
export type Values = Record<string, Scalar | Record<string, Scalar>[]>

export interface FillResult {
  bytes: Uint8Array
  filled: Record<string, number>
  left: string[]
  unused: string[]
  rowsAdded: number
  /** PDF: occurrences drawn in pieces, so not rewritten */
  split?: number
  /** PDF: installed fonts used to draw new characters in the template's own face */
  sameFonts?: string[]
}

const PLACEHOLDER = /\{\{\s*[^{}]+?\s*\}\}/g
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Pairs to replace: placeholder forms, or the literal sample text. */
function pairs(values: Values, literal: boolean): { key: string; finds: string[]; value: string }[] {
  return Object.entries(values)
    .filter(([, v]) => !Array.isArray(v))
    .map(([k, v]) => ({ key: k, finds: literal ? [k] : [`{{${k}}}`, `{{ ${k} }}`], value: str(v) }))
}

async function literalEdit(kind: string, bytes: Uint8Array, values: Values, password?: string): Promise<FillResult> {
  let current = bytes
  const filled: Record<string, number> = {}
  for (const p of pairs(values, true)) {
    const op = { op: 'replace_text' as const, find: p.key, replace: p.value }
    try {
      const r = kind === 'docx' ? await editDocx(current, [op as DocxOp], false) : await editHwp(current, kind as 'hwp' | 'hwpx', [op as HwpOp], { password })
      current = r.bytes!
      filled[p.key] = r.results[0]?.changed ?? 0
    } catch (err) {
      if (err instanceof ToolError && err.code === 'NOT_APPLIED') filled[p.key] = 0
      else throw err
    }
  }
  return { bytes: current, filled, left: [], unused: Object.keys(filled).filter((k) => !filled[k]), rowsAdded: 0 }
}

async function fillPdf(bytes: Uint8Array, name: string, values: Values, literal: boolean): Promise<FillResult> {
  const ps = pairs(values, literal)
  const flat = ps.flatMap((p) => p.finds.map((find) => ({ key: p.key, find, replace: p.value })))
  if (flat.some((f) => /[\r\n]/.test(f.replace))) throw new ToolError('BAD_ARGUMENT', 'A PDF line does not wrap: values for a PDF template must be one line each.', [])
  const r = await replaceMany(bytes, name, flat)
  if (r.failed.length) throw new ToolError('NOT_APPLIED', `"${r.failed[0]!.text}" on page ${r.failed[0]!.page} could not be rewritten in place.`, [])
  const filled: Record<string, number> = Object.fromEntries(ps.map((p) => [p.key, 0]))
  let split = 0
  flat.forEach((f, k) => {
    filled[f.key] += r.per[k]!.replaced
    split += r.per[k]!.split
  })
  const text = (await readPdfPages(r.bytes)).join('\n')
  return { bytes: r.bytes, filled, left: literal ? [] : [...new Set(text.match(PLACEHOLDER) ?? [])], unused: Object.keys(filled).filter((k) => !filled[k]), rowsAdded: 0, split, sameFonts: r.sameFonts }
}

function fillSvg(bytes: Uint8Array, values: Values, literal: boolean): FillResult {
  let svg = new TextDecoder().decode(bytes)
  const filled: Record<string, number> = {}
  for (const p of pairs(values, literal)) {
    filled[p.key] = 0
    for (const find of p.finds) {
      const target = esc(find)
      // only in text, not in attribute values or element names
      svg = svg.replace(/>([^<]*)</g, (whole, text: string) => {
        if (!text.includes(target)) return whole
        const parts = text.split(target)
        filled[p.key] += parts.length - 1
        return `>${parts.join(esc(p.value))}<`
      })
    }
  }
  const textOnly = [...svg.matchAll(/>([^<]*)</g)].map((m) => m[1]).join(' ')
  return { bytes: new TextEncoder().encode(svg), filled, left: literal ? [] : [...new Set(textOnly.match(PLACEHOLDER) ?? [])], unused: Object.keys(filled).filter((k) => !filled[k]), rowsAdded: 0 }
}

export async function fillOne(file: string, kind: string, bytes: Uint8Array, values: Values, opts: { literal?: boolean; password?: string }): Promise<FillResult> {
  const literal = Boolean(opts.literal)
  if (kind === 'hwp' || kind === 'hwpx') return literal ? literalEdit(kind, bytes, values, opts.password) : fillHwpTemplate(bytes, kind, values, opts.password)
  if (kind === 'docx') return literal ? literalEdit(kind, bytes, values) : fillDocxTemplate(bytes, values)
  if (kind === 'pdf') return fillPdf(bytes, basename(file), values, literal)
  if (kind === 'svg') return fillSvg(bytes, values, literal)
  const dk = designKind(kind)
  if (dk) {
    // the engine writes the copy; read it back as bytes like the other formats
    const tmp = join(tmpdir(), `ezpz-fill-${process.pid}-${Date.now().toString(36)}.${kind === 'ai' || kind === 'psd' ? kind : kind}`)
    const ps = pairs(values, literal)
    const r = await fillDesign(file, dk, ps.flatMap((p) => p.finds.map((find) => ({ find, value: p.value }))), tmp)
    const filled: Record<string, number> = {}
    for (const p of ps) filled[p.key] = p.finds.reduce((n, f) => n + (r.filled[f] ?? 0), 0)
    const out = new Uint8Array(readFileSync(tmp))
    rmSync(tmp, { force: true })
    return { bytes: out, filled, left: [], unused: Object.keys(filled).filter((k) => !filled[k]), rowsAdded: 0 }
  }
  throw new ToolError(
    'UNSUPPORTED',
    `Templates in .${kind} are not supported. Templates work for hwp, hwpx, docx, pdf, svg, ai, eps and psd.`,
    [],
  )
}

/** One output name from a pattern like "card-{{name}}" and a row. */
export function nameFor(pattern: string, row: Values, n: number, ext: string): string {
  let name = pattern.replace(/\{\{\s*n\s*\}\}/g, String(n)).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, k: string) => str(row[k]))
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim() || String(n)
  return name.endsWith(`.${ext}`) ? name : `${name}.${ext}`
}

export function uniquePath(dir: string, file: string, taken: Set<string>): string {
  const ext = extname(file)
  const stem = file.slice(0, file.length - ext.length)
  let candidate = file
  for (let k = 2; taken.has(candidate) || existsSync(join(dir, candidate)); k++) candidate = `${stem}-${k}${ext}`
  taken.add(candidate)
  return join(dir, candidate)
}

export interface BatchRow {
  row: number
  path?: string
  ok: boolean
  filled?: Record<string, number>
  left?: string[]
  unused?: string[]
  error?: { code: string; message: string }
}

/**
 * `match` maps the sample text in the design to a key of the row:
 * {"홍길동": "name", "010-0000-0000": "phone"}. The row then fills by literal text.
 */
export function viaMatch(row: Values, match: Record<string, string>): Values {
  return Object.fromEntries(Object.entries(match).map(([sample, key]) => [sample, (row[key] ?? '') as Scalar]))
}

export async function fillMany(
  file: string,
  kind: string,
  bytes: Uint8Array,
  rows: Values[],
  opts: { literal?: boolean; password?: string; outDir: string; pattern: string; match?: Record<string, string> },
): Promise<BatchRow[]> {
  mkdirSync(opts.outDir, { recursive: true })
  const taken = new Set<string>()
  const out: BatchRow[] = []
  for (const [i, row] of rows.entries()) {
    try {
      const r = opts.match
        ? await fillOne(file, kind, bytes, viaMatch(row, opts.match), { ...opts, literal: true })
        : await fillOne(file, kind, bytes, row, opts)
      const total = Object.values(r.filled).reduce((a, b) => a + b, 0)
      if (total === 0) {
        out.push({ row: i + 1, ok: false, error: { code: 'NOT_APPLIED', message: opts.match ? 'none of the sample texts in match was found in the template' : 'no {{placeholder}} of this row is in the template (for sample text, use match or literal)' } })
        continue
      }
      const path = uniquePath(opts.outDir, nameFor(opts.pattern, row, i + 1, kind), taken)
      writeFileSync(path, r.bytes)
      out.push({ row: i + 1, path, ok: r.left.length === 0, filled: r.filled, left: r.left, unused: r.unused })
    } catch (err) {
      const e = err as { code?: string; message?: string }
      out.push({ row: i + 1, ok: false, error: { code: e.code ?? 'UNREADABLE', message: String(e.message ?? err) } })
    }
  }
  return out
}
