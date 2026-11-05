/**
 * PDF redaction that removes, not covers. Same idea as the PDF editor's permanent
 * redaction on ezpzfile.com (src/lib/pdfRedact.ts): a page with a redaction is drawn
 * as a picture with the boxes painted in, and that picture replaces the page. The
 * page's text, pictures and annotations do not travel into the new file, so nothing
 * under a box can be selected, copied or extracted. Other pages are copied as they are,
 * into a fresh document so unused old objects are left behind.
 *
 * Boxes are in points, origin top-left of the page as displayed, y down.
 */
import { PDFDocument } from 'pdf-lib'
import { openPdf } from './docs'
import { ToolError } from './result'

export interface RedactBox {
  page: number
  x: number
  y: number
  w: number
  h: number
}

const SCALE = 3 // 216 dpi
const MAX_SIDE = 7000

interface TextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

/** Boxes around every occurrence of each phrase, from the text layer. */
async function findBoxes(task: Awaited<ReturnType<typeof openPdf>>, phrases: string[], margin: number): Promise<{ boxes: RedactBox[]; found: Record<string, number> }> {
  const doc = await task.promise
  const boxes: RedactBox[] = []
  const found: Record<string, number> = Object.fromEntries(phrases.map((p) => [p, 0]))
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = (content.items as TextItem[]).filter((i) => typeof i.str === 'string' && i.str.length)
    for (const phrase of phrases) {
      for (const it of items) {
        let from = 0
        for (;;) {
          const at = it.str.indexOf(phrase, from)
          if (at < 0) break
          from = at + phrase.length
          const [a, b, , d, e, f] = it.transform as [number, number, number, number, number, number]
          const size = Math.hypot(c0(d), c0(b)) || Math.abs(d) || it.height || 10
          // where the phrase starts and ends inside the item, by character widths:
          // full-width (CJK) characters count 1, others about half
          const weight = (t: string) => [...t].reduce((n, ch) => n + (/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.55), 0)
          const whole = weight(it.str) || 1
          const dir = a >= 0 ? 1 : -1
          const pad = size * 0.15 // a little over each side: a sliver of a glyph is still a leak
          const x0 = e + dir * (it.width * (weight(it.str.slice(0, at)) / whole) - pad)
          const x1 = e + dir * (it.width * (weight(it.str.slice(0, at + phrase.length)) / whole) + pad)
          // corners in user space → viewport (top-left, y down)
          const p1 = vp.convertToViewportPoint(x0, f - size * 0.25)
          const p2 = vp.convertToViewportPoint(x1, f + size * 0.95)
          const x = Math.min(p1[0]!, p2[0]!) - margin
          const y = Math.min(p1[1]!, p2[1]!) - margin
          boxes.push({ page: n, x, y, w: Math.abs(p2[0]! - p1[0]!) + 2 * margin, h: Math.abs(p2[1]! - p1[1]!) + 2 * margin })
          found[phrase]!++
        }
      }
    }
    page.cleanup()
  }
  return { boxes, found }
}
const c0 = (v: number) => v || 0

export async function redactPdf(
  bytes: Uint8Array,
  opts: { boxes?: RedactBox[]; find?: string[]; password?: string; margin?: number },
): Promise<{ pdf: Uint8Array; pages: number; redactedPages: number[]; boxes: number; found: Record<string, number>; verify: Record<string, unknown> }> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const task = await openPdf(bytes, opts.password)
  const view = await task.promise
  const total = view.numPages
  const boxes = [...(opts.boxes ?? [])]
  for (const b of boxes) {
    if (!Number.isInteger(b.page) || b.page < 1 || b.page > total) throw new ToolError('BAD_ARGUMENT', `Box on page ${b.page}: this PDF has ${total} pages.`, [])
    if (!(b.w > 0 && b.h > 0)) throw new ToolError('BAD_ARGUMENT', `Box on page ${b.page} needs a positive w and h (points).`, [])
  }
  let found: Record<string, number> = {}
  if (opts.find?.length) {
    const r = await findBoxes(task, opts.find, opts.margin ?? 1)
    boxes.push(...r.boxes)
    found = r.found
  }
  if (!boxes.length) {
    const none = Object.keys(found).length ? `None of ${Object.keys(found).map((f) => `"${f}"`).join(', ')} is in the text layer (scanned pages have none: give boxes instead).` : 'Give boxes or find.'
    throw new ToolError(Object.keys(found).length ? 'NOT_APPLIED' : 'BAD_ARGUMENT', `Nothing to redact. ${none}`, Object.keys(found).length ? [] : ['boxes or find'])
  }
  const byPage = new Map<number, RedactBox[]>()
  for (const b of boxes) byPage.set(b.page, [...(byPage.get(b.page) ?? []), b])

  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, password: opts.password } as Parameters<typeof PDFDocument.load>[1])
  const out = await PDFDocument.create()
  for (let i = 0; i < total; i++) {
    const n = i + 1
    const list = byPage.get(n)
    if (!list) {
      const [copy] = await out.copyPages(src, [i])
      out.addPage(copy!)
      continue
    }
    const page = await view.getPage(n)
    const vp1 = page.getViewport({ scale: 1 })
    const scale = Math.min(SCALE, MAX_SIDE / Math.max(vp1.width, vp1.height))
    const vp = page.getViewport({ scale })
    const w = Math.max(1, Math.floor(vp.width))
    const h = Math.max(1, Math.floor(vp.height))
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise
    ctx.fillStyle = '#000000'
    for (const b of list) ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale)
    const png = await canvas.encode('png')
    const img = await out.embedPng(png)
    const np = out.addPage([vp1.width, vp1.height])
    np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height })
    page.cleanup()
  }
  const pdf = await out.save()
  await task.destroy()

  // Reopen: page count, and no text left on redacted pages or anywhere for the phrases.
  const checkTask = await openPdf(pdf)
  const check = await checkTask.promise
  let leftOnRedacted = 0
  const leftAnywhere: Record<string, number> = {}
  for (let n = 1; n <= check.numPages; n++) {
    const text = ((await (await check.getPage(n)).getTextContent()).items as TextItem[]).map((i) => i.str ?? '').join('')
    if (byPage.has(n)) leftOnRedacted += text.replace(/\s/g, '').length
    for (const f of opts.find ?? []) leftAnywhere[f] = (leftAnywhere[f] ?? 0) + (text.split(f).length - 1)
  }
  const pagesBack = check.numPages
  await checkTask.destroy()
  const verify = {
    reopened: true,
    pagesBefore: total,
    pagesAfter: pagesBack,
    charactersLeftOnRedactedPages: leftOnRedacted,
    phrasesLeft: leftAnywhere,
    allConfirmed: pagesBack === total && leftOnRedacted === 0 && Object.values(leftAnywhere).every((v) => v === 0),
  }
  return { pdf, pages: total, redactedPages: [...byPage.keys()].sort((a, b) => a - b), boxes: boxes.length, found, verify }
}
