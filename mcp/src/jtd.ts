/**
 * Ichitaro (.jtd): read it, or turn it into Word or PDF.
 *
 * Ichitaro is the Japanese word processor that government offices and schools
 * in Japan have used for decades. Its files open in little besides Ichitaro.
 * The engine is ours (github.com/ezpzfile/ezpzfile-jtd), the same build the
 * editor at ezpzfile.com/ja/jtd-editor runs.
 *
 * PDF is made the way the editor's "Save as PDF" makes it: each page drawn to
 * a picture exactly as the editor shows it, with an invisible text layer on top
 * so the PDF can still be searched and copied. The engine writes the PDF, the
 * drawing happens here (paintPage is the editor's paintItems, minus the
 * on-screen marks).
 */
import mammoth from 'mammoth'
import { PDFDocument } from 'pdf-lib'
import { canvasWithFonts, FALLBACK_FAMILIES } from './canvasFonts'
import { whatItReallyIs } from './result'
import { release, wasmEngine } from './wasmEngine'

interface JtdDocument {
  text(): string
  markdown(): string
  summaryJson(): string
  sheetCount(): number
  free(): void
}

interface JtdEditor {
  pageCount(): number
  pageJson(page: number): string
  toDocx(): Uint8Array
  toPdf(jpegs: Uint8Array, lens: Uint32Array, dims: Uint32Array, title: string): Uint8Array
  free(): void
}

interface JtdGlue {
  initSync(options: { module: BufferSource }): unknown
  JtdDocument: new (bytes: Uint8Array) => JtdDocument
  JtdEditor: { open(bytes: Uint8Array): JtdEditor }
}

const useJtd = wasmEngine<JtdGlue>('ezpzjtd', 'Ichitaro')

/** What Ichitaro wrote about the document. Every field is optional. */
export interface JtdSummary {
  author?: string
  last_author?: string
  created?: string
  saved?: string
  printed?: string
  /** The page count Ichitaro recorded when it last saved */
  pages?: number
  application?: string
  revision?: string
  template?: string
}

/** The engine says "not a compound file" for anything that is not one. Say what that means. */
function opening<T>(bytes: Uint8Array, open: () => T): T {
  try {
    return open()
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/compound file|CFB|OLE2/i.test(message)) {
      throw new Error(
        `This is not an Ichitaro document. ${whatItReallyIs(bytes) ?? 'Ichitaro files (.jtd) are Microsoft compound files, and this one is not. Check that the file is complete and really came from Ichitaro.'}`,
      )
    }
    throw new Error(`The Ichitaro document could not be read: ${message}`)
  }
}

export async function readJtd(
  bytes: Uint8Array,
  format: 'text' | 'markdown',
): Promise<{ text: string; summary: JtdSummary; sheets: number }> {
  return useJtd((mod) => {
    const doc = opening(bytes, () => new mod.JtdDocument(bytes))
    try {
      let summary: JtdSummary = {}
      try {
        summary = JSON.parse(doc.summaryJson()) as JtdSummary
      } catch {
        // the text is what was asked for; the summary is a bonus
      }
      return {
        text: format === 'markdown' ? doc.markdown() : doc.text(),
        summary,
        sheets: doc.sheetCount(),
      }
    } finally {
      release(doc)
    }
  })
}

export async function jtdToDocx(
  bytes: Uint8Array,
): Promise<{ docx: Uint8Array; pages: number; recordedPages?: number; characters: number; reopenedCharacters: number }> {
  const made = await useJtd((mod) => {
    const editor = opening(bytes, () => mod.JtdEditor.open(bytes))
    let doc: JtdDocument | null = null
    try {
      doc = new mod.JtdDocument(bytes)
      return {
        docx: editor.toDocx(),
        pages: editor.pageCount(),
        recordedPages: recorded(mod, bytes),
        characters: doc.text().replace(/\s/g, '').length,
      }
    } finally {
      release(doc)
      release(editor)
    }
  })
  // Reopen the Word file and count what came back, so a silently empty file shows up as a number.
  const back = (await mammoth.extractRawText({ buffer: Buffer.from(made.docx) })).value
  return { ...made, reopenedCharacters: back.replace(/\s/g, '').length }
}

/** The page count Ichitaro saved in the file, to compare with this layout. */
function recorded(mod: JtdGlue, bytes: Uint8Array): number | undefined {
  let doc: JtdDocument | null = null
  try {
    doc = new mod.JtdDocument(bytes)
    const pages = (JSON.parse(doc.summaryJson()) as JtdSummary).pages
    return typeof pages === 'number' && pages > 0 ? pages : undefined
  } catch {
    return undefined
  } finally {
    release(doc)
  }
}

/* ------------------------------------------------------------------ drawing */

const PT = 96 / 72
/** About 200 dpi, the resolution the editor's own PDF export uses. */
const SCALE = 2.2 * PT

/** Mincho first, like the editor: Ichitaro documents are almost always set in it. */
const FONT_STACK = `"Hiragino Mincho ProN","Hiragino Mincho Pro","Yu Mincho","YuMincho","MS Mincho","Noto Serif CJK JP","Noto Serif JP",${FALLBACK_FAMILIES},serif`

/** Dash patterns of Ichitaro's line types, in points. */
const LINE_DASH: Record<number, number[]> = {
  4: [3, 2], 5: [3, 2], 6: [3, 2], 8: [0.8, 1.6], 9: [6, 2.5], 10: [5, 1.5, 1, 1.5], 11: [5, 1.5, 1, 1.5], 15: [1, 1],
}

type Ctx = import('@napi-rs/canvas').SKRSContext2D

interface TextItem { t: 'Text'; xs: number[]; y: number; s: string; size: number; b?: boolean; i?: boolean; color?: string }
interface LineItem { t: 'Line'; x1: number; y1: number; x2: number; y2: number; w: number; k?: number; color?: string }
interface PageData { w: number; h: number; items: Array<TextItem | LineItem | { t: string }> }

function drawLine(g: Ctx, it: LineItem): void {
  const k = it.k || 0
  g.save()
  g.strokeStyle = it.color || '#111'
  g.lineWidth = it.w
  g.setLineDash(LINE_DASH[k] || [])
  const dx = it.x2 - it.x1
  const dy = it.y2 - it.y1
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const seg = (o: number) => {
    g.beginPath()
    g.moveTo(it.x1 + nx * o, it.y1 + ny * o)
    g.lineTo(it.x2 + nx * o, it.y2 + ny * o)
    g.stroke()
  }
  const wave = (o: number) => {
    const step = 2
    const amp = 1.1
    const n = Math.max(1, Math.round(len / step))
    g.beginPath()
    for (let i = 0; i <= n; i += 1) {
      const t = i / n
      const a = (i % 2 ? amp : -amp) + o
      const x = it.x1 + dx * t + nx * a
      const y = it.y1 + dy * t + ny * a
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    }
    g.stroke()
  }
  if (k === 7) {
    g.lineWidth = 0.5
    seg(-0.9)
    seg(0.9)
  } else if (k === 12 || k === 13) wave(0)
  else if (k === 14) {
    g.lineWidth = 0.5
    wave(-1)
    wave(1)
  } else seg(0)
  g.restore()
}

function paintPage(g: Ctx, data: PageData): void {
  g.textBaseline = 'alphabetic'
  for (const item of data.items) {
    if (item.t === 'Text') {
      const it = item as TextItem
      g.font = `${it.i ? 'italic ' : ''}${it.b ? 'bold ' : ''}${it.size}px ${FONT_STACK}`
      g.fillStyle = it.color || '#111'
      const chars = Array.from(it.s)
      for (let k = 0; k < chars.length; k += 1) {
        const ch = chars[k]!
        const half = ch.charCodeAt(0) < 0x2000 || (ch >= '｡' && ch <= 'ﾟ')
        const x = it.xs[k] ?? 0
        if (half) {
          // Half-width cell: centre narrow glyphs, squeeze wide ones (W, M, ...)
          // so the text keeps Ichitaro's monospaced grid.
          const cell = it.size / 2
          const w = g.measureText(ch).width
          if (w > cell) {
            g.save()
            g.translate(x, it.y)
            g.scale(cell / w, 1)
            g.fillText(ch, 0, 0)
            g.restore()
          } else g.fillText(ch, x + (cell - w) / 2, it.y)
        } else g.fillText(ch, x, it.y)
      }
    } else if (item.t === 'Line') {
      drawLine(g, item as LineItem)
    }
  }
}

export async function jtdToPdf(
  bytes: Uint8Array,
  title: string,
): Promise<{ pdf: Uint8Array; pages: number; recordedPages?: number; reopenedPages: number }> {
  const { createCanvas } = await canvasWithFonts()
  const made = await useJtd(async (mod) => {
    const editor = opening(bytes, () => mod.JtdEditor.open(bytes))
    try {
      const pages = editor.pageCount()
      const parts: Uint8Array[] = []
      const lens: number[] = []
      const dims: number[] = []
      for (let i = 0; i < pages; i += 1) {
        const data = JSON.parse(editor.pageJson(i)) as PageData
        const canvas = createCanvas(Math.max(1, Math.round(data.w * SCALE)), Math.max(1, Math.round(data.h * SCALE)))
        const g = canvas.getContext('2d')
        g.fillStyle = '#ffffff'
        g.fillRect(0, 0, canvas.width, canvas.height)
        g.setTransform(SCALE, 0, 0, SCALE, 0, 0)
        paintPage(g, data)
        const jpeg = new Uint8Array(await canvas.encode('jpeg', 90))
        parts.push(jpeg)
        lens.push(jpeg.length)
        dims.push(canvas.width, canvas.height)
      }
      const all = new Uint8Array(lens.reduce((a, b) => a + b, 0))
      let at = 0
      for (const part of parts) {
        all.set(part, at)
        at += part.length
      }
      const pdf = editor.toPdf(all, Uint32Array.from(lens), Uint32Array.from(dims), title)
      return { pdf, pages, recordedPages: recorded(mod, bytes) }
    } finally {
      release(editor)
    }
  })
  // Reopen what was written: a PDF that pdf-lib cannot parse is not a PDF.
  const check = await PDFDocument.load(made.pdf)
  return { ...made, reopenedPages: check.getPageCount() }
}
