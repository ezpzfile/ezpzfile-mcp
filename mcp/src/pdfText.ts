/**
 * Replace text inside a PDF, in place.
 *
 * The website's PDF editor does this when someone retypes a word
 * (src/lib/pdfTextRewrite.ts). It finds the command in the page's content
 * stream that drew the text and changes only the string, so the page keeps its
 * fonts and background and the new text is still real, searchable text. No
 * white box is painted over anything. When the document's own font is a subset
 * without some character of the new text, one font is embedded for that spot
 * only, as the editor does.
 *
 * Matching works on text runs, the pieces a PDF draws in one go. A phrase that
 * a PDF splits across two runs (often at a change of font or colour) is counted
 * but left alone, and the result says how many there were. Nothing is guessed:
 * every occurrence is either replaced in place or reported.
 */
import { PDFDocument } from 'pdf-lib'
import { openForEdit, spareFont } from '../../src/lib/pdfEditOps'
import { rewritePageText, type RewriteProblem, type RunEdit } from '../../src/lib/pdfTextRewrite'
import { readPdfPages } from './docs'

export interface ReplaceResult {
  bytes: Uint8Array
  /** Occurrences of `find` in the page text before the change */
  found: number
  /** Replaced in the content stream */
  replaced: number
  /** Replaced, but with an embedded font because the original lacked a character */
  substituted: number
  /** Present, but split across text runs, so not touched */
  split: number
  /** Inside one run, but the drawing command could not be rewritten */
  failed: Array<{ page: number; text: string; why: RewriteProblem }>
  /** Occurrences of `find` the reopened file still has */
  remaining: number
  pagesChanged: number[]
}

const count = (text: string, find: string) => (find ? text.split(find).length - 1 : 0)

const WHY: Record<RewriteProblem, string> = {
  notFound: 'the drawing command was not where pdfjs placed the text',
  unreadable: 'its font has no table that says which character is which',
  noGlyph: 'a character of the new text exists in no available font',
}

export function explainProblem(why: RewriteProblem): string {
  return WHY[why]
}

export async function replaceText(
  bytes: Uint8Array,
  name: string,
  find: string,
  replace: string,
  pages?: number[],
): Promise<ReplaceResult> {
  if (!find) throw new Error('replace_text needs find: the text to look for.')
  if (/[\r\n]/.test(replace)) throw new Error('replace must be a single line. A PDF line does not wrap on its own.')

  // Occurrences are counted in the page text as doc_read shows it, so a phrase the PDF
  // draws in two pieces is still counted, and reported, rather than silently missed.
  const before = await readPdfPages(bytes)
  const reader = await openForEdit(new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/pdf' }))
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const total = doc.getPageCount()
  const list = (pages?.length ? pages : Array.from({ length: total }, (_, i) => i + 1)).map((n) => n - 1)

  let found = 0
  let replaced = 0
  let substituted = 0
  let split = 0
  const failed: ReplaceResult['failed'] = []
  const pagesChanged: number[] = []

  try {
    for (const index of list) {
      const whole = count(before[index] ?? '', find)
      found += whole
      if (whole === 0) continue
      const runs = await reader.textRuns(index)

      const edits: RunEdit[] = []
      const hits = new Map<RunEdit, number>()
      for (const [i, run] of runs.entries()) {
        const n = count(run.text, find)
        if (n === 0) continue
        const edit: RunEdit = {
          id: `${index}:${i}`,
          x: run.x,
          baseline: run.baseline,
          original: run.text,
          text: run.text.split(find).join(replace),
          dx: 0,
          dy: 0,
          size: run.size,
          homeSize: run.size,
          hscale: run.hscale,
          w: run.w,
        }
        edits.push(edit)
        hits.set(edit, n)
      }
      const inRuns = [...hits.values()].reduce((a, b) => a + b, 0)
      split += Math.max(0, whole - inRuns)
      if (edits.length === 0) continue

      const done = await rewritePageText(
        doc.getPage(index),
        edits,
        (which) => spareFont(doc, which),
        await reader.glyphCodes(index),
      )
      let changed = false
      for (const edit of edits) {
        const how = done.get(edit)
        const n = hits.get(edit) ?? 0
        if (how?.ok) {
          replaced += n
          if (!how.original) substituted += n
          changed = true
        } else {
          failed.push({ page: index + 1, text: edit.original, why: how && !how.ok ? how.why : 'notFound' })
        }
      }
      if (changed) pagesChanged.push(index + 1)
    }
  } finally {
    await reader.destroy()
  }

  const out = pagesChanged.length > 0 ? await doc.save() : bytes

  // Reopen the result and count again, the same way: what is left of `find`,
  // not counting the copies the replacement itself brings in.
  const after = await readPdfPages(out)
  const left = list.reduce((sum, index) => sum + count(after[index] ?? '', find), 0)
  const remaining = Math.max(0, left - replaced * count(replace, find))

  return { bytes: out, found, replaced, substituted, split, failed, remaining, pagesChanged }
}
