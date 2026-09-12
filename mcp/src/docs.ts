/**
 * Reading documents that are not HWP: DOCX, EML, PDF, and tables.
 *
 * postal-mime and xlsx run in Node unchanged, so the site functions
 * (src/lib/docOps.ts, src/lib/emlOps.ts) are called as they are. They take a
 * File, and Node 20+ has a global File, so the only glue is wrapping the
 * bytes. mammoth is the exception, see readDocx.
 *
 * htmlToMarkdown walks the DOM, which Node lacks, so linkedom fills in
 * DOMParser, Node and Element before it runs.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DOMParser, Element, Node } from 'linkedom'
import mammoth from 'mammoth'
import { htmlToMarkdown, readSheets, sheetToBlob, type SheetsResult } from '../../src/lib/docOps'
import { emlToPlainText, parseEml } from '../../src/lib/emlOps'

const require = createRequire(import.meta.url)

function installDom(): void {
  const g = globalThis as Record<string, unknown>
  if (!g.DOMParser) g.DOMParser = DOMParser
  if (!g.Node) g.Node = Node
  if (!g.Element) g.Element = Element
}

export type ReadFormat = 'text' | 'markdown'

/**
 * mammoth's Node build takes { buffer }, the browser build takes { arrayBuffer }.
 * That one difference is why the site's docxTo() is not called here. The
 * HTML to markdown step is shared, so tables and lists come out the same.
 */
export async function readDocx(bytes: Uint8Array, format: ReadFormat): Promise<string> {
  const buffer = Buffer.from(bytes)
  if (format === 'markdown') {
    installDom()
    const html = (await mammoth.convertToHtml({ buffer })).value
    // linkedom drops top level elements of a bare fragment. A browser would
    // wrap them in <body> on its own, so do that here.
    return htmlToMarkdown(`<html><body>${html}</body></html>`)
  }
  return (await mammoth.extractRawText({ buffer })).value
}

export interface EmlSummary {
  subject: string
  from: string
  to: string[]
  date: string
  attachments: { filename: string; mimeType: string; size: number }[]
  remoteImageCount: number
}

export async function readEml(bytes: Uint8Array, name: string): Promise<{ text: string; summary: EmlSummary }> {
  const message = await parseEml(new File([bytes.slice().buffer as ArrayBuffer], name))
  const text = emlToPlainText(message, {
    from: 'From',
    to: 'To',
    cc: 'Cc',
    subject: 'Subject',
    date: 'Date',
  })
  const person = (a: { name: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address)
  return {
    text,
    summary: {
      subject: message.subject,
      from: message.from ? person(message.from) : '',
      to: message.to.map(person),
      date: message.date,
      attachments: message.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
      remoteImageCount: message.remoteImageCount,
    },
  }
}

/* ------------------------------------------------------------------ PDF text */

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<Pdfjs> | null = null

/** pdfjs needs its font and CMap folders to read CJK text. They ship with the package. */
export async function loadPdfjs(): Promise<{ pdfjs: Pdfjs; root: string }> {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<Pdfjs>
  const pdfjs = await pdfjsPromise
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  return { pdfjs, root }
}

export async function openPdf(bytes: Uint8Array, password?: string) {
  const { pdfjs, root } = await loadPdfjs()
  const task = pdfjs.getDocument({
    data: bytes,
    password,
    cMapUrl: join(root, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
    // pdfjs logs warnings with console.log. On a stdio MCP server that would
    // corrupt the protocol stream, so only real errors may print.
    verbosity: 0,
  })
  return task
}

export interface PdfTextResult {
  text: string
  pages: number
  /** Pages that produced no text at all, usually scans */
  emptyPages: number[]
}

export async function readPdfText(bytes: Uint8Array, password?: string): Promise<PdfTextResult> {
  const task = await openPdf(bytes, password)
  const doc = await task.promise
  const parts: string[] = []
  const emptyPages: number[] = []
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let lastY: number | null = null
      let line = ''
      const lines: string[] = []
      for (const item of content.items) {
        if (!('str' in item)) continue
        const y = item.transform[5]
        // A new baseline means a new line. pdfjs gives EOL hints too, but the
        // baseline check also catches columns that share a text run.
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          lines.push(line)
          line = ''
        }
        line += item.str
        if (item.hasEOL) {
          lines.push(line)
          line = ''
          lastY = null
          continue
        }
        lastY = y
      }
      if (line) lines.push(line)
      const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim()
      if (!text) emptyPages.push(n)
      parts.push(text)
      page.cleanup()
    }
    return { text: parts.join('\n\n'), pages: doc.numPages, emptyPages }
  } finally {
    await task.destroy()
  }
}

/* ------------------------------------------------------------------ tables */

export async function readTable(bytes: Uint8Array, name: string): Promise<SheetsResult> {
  return readSheets(new File([bytes.slice().buffer as ArrayBuffer], name))
}

export async function tableTo(
  sheets: SheetsResult,
  format: 'csv' | 'json',
  sheetPick?: string | number,
): Promise<{ bytes: Uint8Array; sheet: string; rows: number; columns: number }> {
  const chosen =
    sheetPick === undefined
      ? sheets.sheets[0]
      : typeof sheetPick === 'number'
        ? sheets.sheets[sheetPick]
        : sheets.sheets.find((s) => s.name === sheetPick)
  if (!chosen) {
    throw new Error(
      `Sheet not found. Available sheets: ${sheets.sheets.map((s) => s.name).join(', ')}`,
    )
  }
  const blob = await sheetToBlob(chosen, format)
  const columns = chosen.rows.reduce((n, r) => Math.max(n, r.length), 0)
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    sheet: chosen.name,
    rows: chosen.rows.length,
    columns,
  }
}
