/**
 * DocuWorks (.xdw documents, .xbd binders): read them, or turn them into PDF.
 *
 * DocuWorks is Fujifilm's document format, everywhere in Japanese offices and
 * readable only with its own viewer. The engine is ours
 * (github.com/ezpzfile/ezpzfile-xdw), the same build the editor at
 * ezpzfile.com/ja/xdw-editor runs.
 *
 * PDF is made the way the editor's "Save as PDF" makes it: each page drawn to a
 * picture, the engine adding an invisible text layer so the PDF stays
 * searchable. paintPage is the editor's paint(), drawing on @napi-rs/canvas.
 */
import { PDFDocument } from 'pdf-lib'
import { canvasWithFonts, FALLBACK_FAMILIES } from './canvasFonts'
import { whatItReallyIs } from './result'
import { release, wasmEngine } from './wasmEngine'

interface XdwDoc {
  pageCount(): number
  render(page: number): string
  image(page: number, index: number): Uint8Array
  forget(page: number): void
  text(page: number): string
  binder(): string
  isSigned(): boolean
  toPdf(jpegs: Uint8Array, lens: Uint32Array, dims: Uint32Array, title: string): Uint8Array
  free(): void
}

interface XdwGlue {
  initSync(options: { module: BufferSource }): unknown
  XdwDoc: new (bytes: Uint8Array) => XdwDoc
}

const useXdw = wasmEngine<XdwGlue>('ezpzxdw', 'DocuWorks')

export interface BinderDoc {
  name: string
  first_page: number
  pages: number
}

function opening(bytes: Uint8Array, mod: XdwGlue): XdwDoc {
  try {
    return new mod.XdwDoc(bytes)
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/not a DocuWorks file/i.test(message)) {
      throw new Error(
        `This is not a DocuWorks document. ${whatItReallyIs(bytes) ?? 'DocuWorks files (.xdw, .xbd) start with a header this one does not have. Check that the file is complete.'}`,
      )
    }
    throw new Error(`The DocuWorks document could not be read: ${message}`)
  }
}

function binderOf(doc: XdwDoc): { name: string; docs: BinderDoc[] } | null {
  try {
    return JSON.parse(doc.binder()) as { name: string; docs: BinderDoc[] } | null
  } catch {
    return null
  }
}

export async function readXdw(
  bytes: Uint8Array,
  format: 'text' | 'markdown',
): Promise<{ text: string; pages: number; emptyPages: number[]; binder: { name: string; docs: BinderDoc[] } | null; signed: boolean }> {
  return useXdw((mod) => {
    const doc = opening(bytes, mod)
    try {
      const pages = doc.pageCount()
      const binder = binderOf(doc)
      const texts: string[] = []
      const emptyPages: number[] = []
      for (let i = 0; i < pages; i += 1) {
        const text = doc.text(i).trim()
        doc.forget(i)
        if (!text) emptyPages.push(i + 1)
        texts.push(text)
      }
      // A binder is several documents bound together. Name each one where it starts.
      const starts = new Map((binder?.docs ?? []).map((d) => [d.first_page, d.name]))
      const parts: string[] = []
      for (const [i, text] of texts.entries()) {
        const name = starts.get(i)
        if (name !== undefined) parts.push(format === 'markdown' ? `## ${name}` : `[${name}]`)
        if (text) parts.push(text)
      }
      return { text: parts.join('\n\n'), pages, emptyPages, binder, signed: doc.isSigned() }
    } finally {
      release(doc)
    }
  })
}

/* ------------------------------------------------------------------ drawing */

type Canvas = typeof import('@napi-rs/canvas')
type Ctx = import('@napi-rs/canvas').SKRSContext2D
type Picture = import('@napi-rs/canvas').Image | import('@napi-rs/canvas').Canvas

/** 150 dpi, in pixels per 1/100 mm (the unit DocuWorks measures in). The editor's PDF uses the same. */
const SCALE = 150 / 2540

const SANS = `"MS Gothic","MS PGothic","Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic","Noto Sans JP","Noto Sans CJK JP",${FALLBACK_FAMILIES},sans-serif`
const SERIF = `"MS Mincho","MS PMincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP","Noto Serif CJK JP",${FALLBACK_FAMILIES},serif`

const hex = (n: number) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')

function fontFor(face: string, weight: number, italic: boolean, size: number): string {
  const stack = /明朝|Mincho|Serif|Times|Century/i.test(face) ? SERIF : SANS
  const named = face ? `"${face.replace(/"/g, '')}",` : ''
  return `${italic ? 'italic ' : ''}${weight >= 600 ? 700 : 400} ${size}px ${named}${stack}`
}

function path2d(canvas: Canvas, a: number[]) {
  const p = new canvas.Path2D()
  for (let i = 0; i < a.length; ) {
    const c = a[i++]
    if (c === 0) p.moveTo(a[i++]!, a[i++]!)
    else if (c === 1) p.lineTo(a[i++]!, a[i++]!)
    else if (c === 2) {
      p.bezierCurveTo(a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!, a[i + 4]!, a[i + 5]!)
      i += 6
    } else p.closePath()
  }
  return p
}

/** In vertical writing these turn with the line instead of standing upright. */
const TURN = new Set(Array.from('「」『』（）【】〔〕［］｛｝〈〉《》ー～〜…‥－＝→←―─'))
const isFull = (c: string) => c.codePointAt(0)! >= 0x2e80 && !(c >= '｡' && c <= 'ﾟ')

interface Display {
  w: number
  h: number
  clips: number[][][]
  items: unknown[][]
  images: Array<{ k: 'jpeg' | 'rgba'; w: number; h: number }>
}

async function pictures(canvas: Canvas, doc: XdwDoc, page: number, d: Display): Promise<Array<Picture | null>> {
  // Take every picture's bytes first, before anything else can drop the engine's copy.
  const raw = d.images.map((_, k) => doc.image(page, k))
  const out: Array<Picture | null> = []
  for (const [k, im] of d.images.entries()) {
    const bytes = raw[k]!
    try {
      if (!bytes.length) out.push(null)
      else if (im.k === 'jpeg') out.push(await canvas.loadImage(Buffer.from(bytes)))
      else {
        const holder = canvas.createCanvas(im.w, im.h)
        holder
          .getContext('2d')
          .putImageData(new canvas.ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length), im.w, im.h), 0, 0)
        out.push(holder)
      }
    } catch {
      out.push(null)
    }
  }
  return out
}

function paintPage(canvas: Canvas, ctx: Ctx, d: Display, imgs: Array<Picture | null>, k: number): number {
  let missing = 0
  const measured = new Map<string, number>()
  const measure = (c: string) => {
    const key = ctx.font + '\u0000' + c
    let w = measured.get(key)
    if (w === undefined) {
      w = ctx.measureText(c).width
      measured.set(key, w)
    }
    return w
  }

  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, d.w, d.h)
  const clips = d.clips.map((c) => c.map((one) => path2d(canvas, one)))
  const minW = 0.8 / k
  let cur = 0
  ctx.save()
  for (const it of d.items) {
    const t = it[0] as string
    const clip = (t === 'f' ? it[4] : t === 's' ? it[7] : t === 't' ? it[15] : it[3]) as number
    if (clip !== cur) {
      ctx.restore()
      ctx.save()
      if (clip) for (const p of clips[clip] || []) ctx.clip(p)
      cur = clip
    }
    if (t === 'f') {
      ctx.fillStyle = hex(it[2] as number)
      if (it[5]) {
        ctx.save()
        ctx.globalCompositeOperation = 'multiply'
      }
      ctx.fill(path2d(canvas, it[1] as number[]), it[3] ? 'evenodd' : 'nonzero')
      if (it[5]) ctx.restore()
    } else if (t === 's') {
      ctx.strokeStyle = hex(it[2] as number)
      ctx.lineWidth = Math.max(it[3] as number, minW)
      ctx.setLineDash(it[4] as number[])
      ctx.lineCap = (['round', 'square', 'butt'] as const)[it[5] as number] || 'round'
      ctx.lineJoin = (['round', 'bevel', 'miter'] as const)[it[6] as number] || 'round'
      ctx.stroke(path2d(canvas, it[1] as number[]))
    } else if (t === 't') {
      const [, x, y, angle, size, sx, face, weight, italic, under, strike, vert, color, text, xs] = it as [
        string, number, number, number, number, number, string, number, boolean, boolean, boolean, boolean, number, string, number[],
      ]
      if (size * k < 0.6) continue
      ctx.save()
      ctx.translate(x, y)
      if (angle) ctx.rotate((-angle * Math.PI) / 180)
      if (sx && sx !== 1) ctx.scale(sx, 1)
      ctx.font = fontFor(face, weight, italic, size)
      ctx.fillStyle = hex(color)
      ctx.textBaseline = 'alphabetic'
      const chars = Array.from(text)
      for (let n = 0; n < chars.length; n += 1) {
        const c = chars[n]!
        const cx = xs.length ? xs[n]! : n * size
        const adv = xs.length > n + 1 ? xs[n + 1]! - cx : 0
        if (!vert && adv > 0) {
          // Proportional fonts give some characters less room than the
          // fallback font's glyph needs: squeeze the glyph into its advance.
          const w0 = measure(c)
          if (w0 > adv * 1.15) {
            ctx.save()
            ctx.translate(cx, 0)
            ctx.scale(adv / w0, 1)
            ctx.fillText(c, 0, 0)
            ctx.restore()
            continue
          }
        }
        if (vert && isFull(c) && !TURN.has(c)) {
          // Vertical writing: CJK glyphs stand upright.
          ctx.save()
          ctx.translate(cx + size * 0.5, -size * 0.38)
          ctx.rotate(-Math.PI / 2)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(c, 0, 0)
          ctx.restore()
        } else ctx.fillText(c, cx, 0)
      }
      if (under || strike) {
        const w = xs.length ? xs[xs.length - 1]! + size : chars.length * size
        ctx.fillRect(0, under ? size * 0.12 : -size * 0.3, w, Math.max(size * 0.05, minW))
      }
      ctx.restore()
    } else if (t === 'i') {
      const img = imgs[it[1] as number]
      if (!img) {
        missing += 1
        continue
      }
      const m = it[2] as number[]
      ctx.save()
      ctx.transform(m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!)
      if ((it[4] as number) < 1) ctx.globalAlpha = it[4] as number
      if (it[5]) ctx.globalCompositeOperation = 'multiply'
      ctx.drawImage(img, 0, 0, 1, 1)
      ctx.restore()
    }
  }
  ctx.restore()
  return missing
}

export async function xdwToPdf(
  bytes: Uint8Array,
  title: string,
): Promise<{ pdf: Uint8Array; pages: number; reopenedPages: number; missingPictures: number; binderDocs: number; signed: boolean }> {
  const canvas = await canvasWithFonts()
  const made = await useXdw(async (mod) => {
    const doc = opening(bytes, mod)
    try {
      const pages = doc.pageCount()
      const parts: Uint8Array[] = []
      const lens: number[] = []
      const dims: number[] = []
      let missingPictures = 0
      for (let i = 0; i < pages; i += 1) {
        const d = JSON.parse(doc.render(i)) as Display
        const imgs = await pictures(canvas, doc, i, d)
        const sheet = canvas.createCanvas(Math.max(1, Math.round(d.w * SCALE)), Math.max(1, Math.round(d.h * SCALE)))
        missingPictures += paintPage(canvas, sheet.getContext('2d'), d, imgs, SCALE)
        doc.forget(i)
        const jpeg = new Uint8Array(await sheet.encode('jpeg', 88))
        parts.push(jpeg)
        lens.push(jpeg.length)
        dims.push(sheet.width, sheet.height)
      }
      const all = new Uint8Array(lens.reduce((a, b) => a + b, 0))
      let at = 0
      for (const part of parts) {
        all.set(part, at)
        at += part.length
      }
      const pdf = doc.toPdf(all, Uint32Array.from(lens), Uint32Array.from(dims), title)
      return { pdf, pages, missingPictures, binderDocs: binderOf(doc)?.docs.length ?? 0, signed: doc.isSigned() }
    } finally {
      release(doc)
    }
  })
  const check = await PDFDocument.load(made.pdf)
  return { ...made, reopenedPages: check.getPageCount() }
}
