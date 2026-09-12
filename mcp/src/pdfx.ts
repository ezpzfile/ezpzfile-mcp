/**
 * PDF work that pdf-lib alone cannot do.
 *
 * - protect, unlock, compress: qpdf compiled to WebAssembly (@jspawn/qpdf-wasm).
 *   The browser loader in src/lib/pdfCrypto.ts cannot be reused: it fetches the
 *   wasm over HTTP and the Emscripten wrapper insists on fetch() even in Node.
 *   So the wasm is read from disk and handed over through instantiateWasm.
 *   qpdf also writes to the process stdout, which on a stdio MCP server is the
 *   protocol channel. Module.stdout/stderr sinks keep it off that stream.
 * - page rendering: pdfjs plus @napi-rs/canvas, because pdfjs needs a canvas.
 * - images to PDF: pdf-lib, same as the site. sharp only normalizes formats
 *   pdf-lib cannot embed (WebP, TIFF, ...).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { openPdf } from './docs'

const require = createRequire(import.meta.url)

/* ------------------------------------------------------------------ qpdf */

type QpdfModule = {
  FS: {
    writeFile: (path: string, data: Uint8Array) => void
    readFile: (path: string) => Uint8Array
    unlink: (path: string) => void
  }
  callMain: (args: string[]) => number | undefined
}

let qpdfPromise: Promise<QpdfModule> | null = null
let captured: number[] = []

async function getQpdf(): Promise<QpdfModule> {
  if (!qpdfPromise) {
    qpdfPromise = (async () => {
      const init = require('@jspawn/qpdf-wasm/qpdf.js') as (o: unknown) => Promise<QpdfModule>
      const wasm = readFileSync(require.resolve('@jspawn/qpdf-wasm/qpdf.wasm'))
      const sink = (c: number | null) => {
        if (c !== null && c !== undefined) captured.push(c)
      }
      return init({
        instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => {
          WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance))
          return {}
        },
        noExitRuntime: true,
        stdout: sink,
        stderr: sink,
        print: () => {},
        printErr: () => {},
      })
    })().catch((err) => {
      qpdfPromise = null
      throw err
    })
  }
  return qpdfPromise
}

export class QpdfError extends Error {
  constructor(
    readonly kind: 'wrong-password' | 'not-encrypted' | 'failed',
    readonly detail: string,
  ) {
    super(
      kind === 'wrong-password'
        ? 'Wrong password.'
        : kind === 'not-encrypted'
          ? 'This PDF is not encrypted.'
          : `qpdf failed: ${detail}`,
    )
  }
}

async function runQpdf(input: Uint8Array, args: (inPath: string, outPath: string) => string[]) {
  const mod = await getQpdf()
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const inPath = `/in-${stamp}.pdf`
  const outPath = `/out-${stamp}.pdf`
  captured = []
  mod.FS.writeFile(inPath, input)

  let code: number | undefined
  try {
    code = mod.callMain(args(inPath, outPath))
  } catch (error) {
    // Emscripten turns exit() into an exception.
    code = (error as { status?: number }).status ?? 2
  }

  let out: Uint8Array | null = null
  try {
    out = mod.FS.readFile(outPath)
  } catch {
    out = null
  }
  for (const p of [inPath, outPath]) {
    try {
      mod.FS.unlink(p)
    } catch {
      /* already gone */
    }
  }

  const log = Buffer.from(captured).toString('utf8')
  // qpdf exits 3 for warnings only. A produced file counts as success.
  if (!out || out.length === 0) {
    if (/invalid password|password.*incorrect/i.test(log)) throw new QpdfError('wrong-password', log)
    if (/not encrypted|is not encrypted/i.test(log)) throw new QpdfError('not-encrypted', log)
    throw new QpdfError('failed', log || `exit ${code}`)
  }
  return { bytes: out, log }
}

export async function protectPdf(
  bytes: Uint8Array,
  opts: { password: string; ownerPassword?: string; allowPrint?: boolean; allowCopy?: boolean; currentPassword?: string },
): Promise<Uint8Array> {
  const owner = opts.ownerPassword?.trim() || opts.password
  const { bytes: out } = await runQpdf(bytes, (i, o) => [
    ...(opts.currentPassword ? [`--password=${opts.currentPassword}`] : []),
    '--encrypt',
    opts.password,
    owner,
    '256',
    `--print=${opts.allowPrint === false ? 'none' : 'full'}`,
    `--extract=${opts.allowCopy === false ? 'n' : 'y'}`,
    '--',
    i,
    o,
  ])
  return out
}

export async function unlockPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const { bytes: out } = await runQpdf(bytes, (i, o) => [`--password=${password}`, '--decrypt', i, o])
  return out
}

/**
 * Lossless size reduction: object streams, stream recompression, removal of
 * unreferenced objects. Pixels are never touched, so the page looks the same.
 * Files that are already tight come back the same size, and the caller sees
 * both numbers rather than a promise.
 */
export async function compressPdf(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const { bytes: out } = await runQpdf(bytes, (i, o) => [
    ...(password ? [`--password=${password}`] : []),
    '--object-streams=generate',
    '--recompress-flate',
    '--compression-level=9',
    '--remove-unreferenced-resources=yes',
    i,
    o,
  ])
  return out
}

export function looksEncrypted(bytes: Uint8Array): boolean {
  const tail = Buffer.from(bytes.subarray(-4096)).toString('latin1')
  return tail.includes('/Encrypt')
}

/* ------------------------------------------------------------------ render */

export interface RenderedPage {
  page: number
  bytes: Uint8Array
  width: number
  height: number
}

export async function renderPages(
  bytes: Uint8Array,
  opts: { pages?: number[]; dpi: number; format: 'png' | 'jpeg'; quality?: number; password?: string },
): Promise<RenderedPage[]> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const task = await openPdf(bytes, opts.password)
  const doc = await task.promise
  const list = (opts.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)).filter(
    (n) => n >= 1 && n <= doc.numPages,
  )
  const scale = opts.dpi / 72
  const out: RenderedPage[] = []
  try {
    for (const n of list) {
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale })
      const width = Math.max(1, Math.floor(viewport.width))
      const height = Math.max(1, Math.floor(viewport.height))
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      // pdfjs types expect a DOM canvas. @napi-rs/canvas implements the same 2D API.
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise
      const encoded =
        opts.format === 'png'
          ? await canvas.encode('png')
          : await canvas.encode('jpeg', opts.quality ?? 90)
      out.push({ page: n, bytes: new Uint8Array(encoded), width, height })
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return out
}

/* ------------------------------------------------------------------ images to pdf */

function isPng(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}
function isJpeg(b: Uint8Array) {
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

export async function imagesToPdf(
  images: Uint8Array[],
  opts: { pageSize: 'fit' | 'a4'; margin: number },
): Promise<{ pdf: Uint8Array; pages: number }> {
  const out = await PDFDocument.create()
  const A4 = { w: 595.28, h: 841.89 }

  for (let bytes of images) {
    // pdf-lib embeds only PNG and JPEG. Anything else goes through sharp once.
    if (!isPng(bytes) && !isJpeg(bytes)) {
      bytes = new Uint8Array(await sharp(bytes).png().toBuffer())
    }
    const image = isPng(bytes) ? await out.embedPng(bytes) : await out.embedJpg(bytes)

    if (opts.pageSize === 'fit') {
      const page = out.addPage([image.width, image.height])
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
    } else {
      const page = out.addPage([A4.w, A4.h])
      const m = opts.margin
      const scale = Math.min((A4.w - m * 2) / image.width, (A4.h - m * 2) / image.height, 1)
      const w = image.width * scale
      const h = image.height * scale
      page.drawImage(image, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h })
    }
  }
  return { pdf: await out.save(), pages: out.getPageCount() }
}
