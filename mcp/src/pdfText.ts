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
import { PDFDocument, type PDFFont } from 'pdf-lib'
import pdfFontkit from '@pdf-lib/fontkit'
import { loadFont } from './engine'
import { covers, findSystemFont, fontBytes, subsetFont, type SysFont } from './sysFonts'
import { openForEdit, spareFont } from '../../src/lib/pdfEditOps'
import { rewritePageText, type RewriteProblem, type RunEdit } from '../../src/lib/pdfTextRewrite'
import { readPdfPages } from './docs'

export interface ReplaceResult {
  bytes: Uint8Array
  /** Occurrences of `find` in the page text before the change */
  found: number
  /** Replaced in the content stream */
  replaced: number
  /** installed or downloaded copies of the document's own fonts that drew new characters */
  sameFonts?: string[]
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
  const r = await replaceMany(bytes, name, [{ find, replace }], pages)
  return { ...r.per[0]!, bytes: r.bytes, failed: r.failed, pagesChanged: r.pagesChanged, sameFonts: r.sameFonts }
}

export interface ManyResult {
  bytes: Uint8Array
  per: Omit<ReplaceResult, 'bytes' | 'failed' | 'pagesChanged' | 'sameFonts'>[]
  failed: ReplaceResult['failed']
  pagesChanged: number[]
  /** installed fonts that drew new characters in the document's own face */
  sameFonts: string[]
}

const embedded = new WeakMap<PDFDocument, Map<string, PDFFont>>()

async function embedSystem(doc: PDFDocument, f: SysFont, needed: string): Promise<PDFFont> {
  let pocket = embedded.get(doc)
  if (!pocket) embedded.set(doc, (pocket = new Map()))
  const hit = pocket.get(f.postscript)
  if (hit) return hit
  doc.registerFontkit(pdfFontkit)
  // whole font: the subsetter shipped with pdf-lib drops glyphs (see src/lib/pdfEditOps.ts)
  // cut to the characters this document needs with harfbuzz, then embed that whole
  const font = await doc.embedFont(await subsetFont(fontBytes(f), needed), { subset: false })
  pocket.set(f.postscript, font)
  return font
}

async function embedBundled(doc: PDFDocument, key: 'gothic' | 'myeongjo', needed: string): Promise<PDFFont> {
  let pocket = embedded.get(doc)
  if (!pocket) embedded.set(doc, (pocket = new Map()))
  const hit = pocket.get(`bundled:${key}`)
  if (hit) return hit
  doc.registerFontkit(pdfFontkit)
  const font = await doc.embedFont(await subsetFont(loadFont(key), needed), { subset: false })
  pocket.set(`bundled:${key}`, font)
  return font
}

/**
 * The run's own font with every character needed: the installed copy, or else the same
 * free family fetched by name from the font finder's list (Google Fonts, OFL).
 */
async function sameFontFor(pdfName: string, text: string): Promise<SysFont | null> {
  if (process.env.EZPZFILE_NO_SYSTEM_FONTS === '1' || !pdfName) return null
  const f = findSystemFont(pdfName)
  if (f && covers(f, text)) return f
  const { freeFont } = await import('./freeFonts')
  const free = await freeFont(pdfName)
  return free && covers(free, text) ? free : null
}

/**
 * Several replacements in one pass over the document. A run holding any of the
 * phrases is rewritten once with all of them applied, so a font that has to be
 * embedded for new characters is embedded once, not once per phrase (a business card
 * with four fields would otherwise carry the same font four times).
 */
export async function replaceMany(
  bytes: Uint8Array,
  name: string,
  pairs: { find: string; replace: string }[],
  pages?: number[],
): Promise<ManyResult> {
  for (const p of pairs) {
    if (!p.find) throw new Error('replace_text needs find: the text to look for.')
    if (/[\r\n]/.test(p.replace)) throw new Error('replace must be a single line. A PDF line does not wrap on its own.')
  }
  const before = await readPdfPages(bytes)
  const reader = await openForEdit(new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/pdf' }))
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const total = doc.getPageCount()
  const list = (pages?.length ? pages : Array.from({ length: total }, (_, i) => i + 1)).map((n) => n - 1)
  const per = pairs.map(() => ({ found: 0, replaced: 0, substituted: 0, split: 0, remaining: 0 }))
  const failed: ReplaceResult['failed'] = []
  const pagesChanged: number[] = []
  const sameFontUsed = new Set<string>()
  const apply = (t: string) => pairs.reduce((acc, p) => acc.split(p.find).join(p.replace), t)
  // every character a rewritten run can hold: the pages' text plus the new values
  const neededText = before.map((t) => apply(t)).join('') + pairs.map((p) => p.replace).join('')

  try {
    for (const index of list) {
      const wholes = pairs.map((p) => count(before[index] ?? '', p.find))
      wholes.forEach((w, k) => (per[k]!.found += w))
      if (wholes.every((w) => w === 0)) continue
      const runs = await reader.textRuns(index)
      const edits: RunEdit[] = []
      const hits = new Map<RunEdit, number[]>()
      for (const [i, run] of runs.entries()) {
        const ns = pairs.map((p) => count(run.text, p.find))
        if (ns.every((n) => n === 0)) continue
        const edit: RunEdit = {
          id: `${index}:${i}`,
          x: run.x,
          baseline: run.baseline,
          original: run.text,
          text: apply(run.text),
          dx: 0,
          dy: 0,
          size: run.size,
          homeSize: run.size,
          hscale: run.hscale,
          w: run.w,
        }
        edits.push(edit)
        hits.set(edit, ns)
      }
      pairs.forEach((_, k) => {
        const inRuns = [...hits.values()].reduce((a, ns) => a + (ns[k] ?? 0), 0)
        per[k]!.split += Math.max(0, wholes[k]! - inRuns)
      })
      if (edits.length === 0) continue
      // When the run's own font lacks a new character, draw it with the installed copy of
      // that very font (same face, same weight) if this machine has it; else a bundled one.
      const fallback = async (which: Parameters<typeof spareFont>[1], named?: string) => {
        const text = edits.map((e) => e.text).join('')
        const own = named ? await sameFontFor(named, text) : null
        if (own) {
          sameFontUsed.add(own.postscript)
          return embedSystem(doc, own, neededText)
        }
        // the bundled Korean faces, cut down to the characters used: whole, each file
        // would carry 2 to 3 MB of font for a name (a batch of 100 made 757 KB files)
        if (which === 'gothic' || which === 'myeongjo') return embedBundled(doc, which, neededText)
        return spareFont(doc, which)
      }
      const done = await rewritePageText(doc.getPage(index), edits, fallback, await reader.glyphCodes(index))
      let changed = false
      for (const edit of edits) {
        const how = done.get(edit)
        const ns = hits.get(edit) ?? []
        if (how?.ok) {
          ns.forEach((n, k) => {
            per[k]!.replaced += n
            if (!how.original) per[k]!.substituted += n
          })
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
  const after = await readPdfPages(out)
  pairs.forEach((p, k) => {
    const left = list.reduce((sum, index) => sum + count(after[index] ?? '', p.find), 0)
    const brought = pairs.reduce((sum, q, j) => sum + per[j]!.replaced * count(q.replace, p.find), 0)
    per[k]!.remaining = Math.max(0, left - brought)
  })
  return { bytes: out, per, failed, pagesChanged, sameFonts: [...sameFontUsed] }
}
