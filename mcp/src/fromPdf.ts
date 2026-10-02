/**
 * PDF back into documents people can edit: Word, Excel, HWP and HWPX.
 *
 * The website's code does all of it. src/lib/pdfLayout.ts rebuilds paragraphs,
 * tables and pictures from where the text sits on each page, pdfConvertOps.ts
 * writes DOCX and XLSX, pdfHwpOps.ts fills a Hangul document through the HWP
 * engine. build.mjs swaps the few browser-only pieces they lean on for the
 * Node versions in src/shims, so both sides make the same guesses.
 *
 * A PDF does not record what was a paragraph or a table, so this is a
 * reconstruction, not a conversion, and the result says so. Pages with no text
 * at all (scans) are reported by number rather than guessed at: there is no
 * text recognition here.
 */
import mammoth from 'mammoth'
import { PDFDocument } from 'pdf-lib'
import { extractPdfLayout, PdfTextError } from '../../src/lib/pdfLayout'
import { layoutToDocx, layoutToXlsx } from '../../src/lib/pdfConvertOps'
import { pdfToHwp } from '../../src/lib/pdfHwpOps'

export type OfficeTarget = 'docx' | 'xlsx' | 'hwp' | 'hwpx'

export interface OfficeResult {
  bytes: Uint8Array
  /** Pages in the source PDF */
  sourcePages: number
  /** Source pages without any text, usually scans */
  emptyPages: number[]
  tables: number
  images: number
  /** Some pictures could not be taken out; the text is complete */
  imagesDropped?: boolean
  /** What the reopened output showed */
  check: string
  /** The reopened output looked as expected */
  verified: boolean
  /** HWP/HWPX only: pages in the new document, elements the engine could not carry */
  pages?: number
  lost?: number
}

function toFile(bytes: Uint8Array, name: string): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/pdf' })
}

/** The layout code speaks in reasons. Turn them into something an agent can act on. */
function explain(err: unknown, password?: string): never {
  if (err instanceof PdfTextError) {
    if (err.reason === 'ENCRYPTED') {
      throw new Error(password ? 'Wrong password.' : 'This PDF is password protected. Call again with the password argument.')
    }
    if (err.reason === 'NO_TEXT') {
      throw new Error(
        'No page of this PDF has a text layer, so there is no text to rebuild a document from. It is most likely a scan. doc_convert to png shows the pages as pictures.',
      )
    }
    throw new Error('The PDF could not be read. It may be damaged or not a PDF at all.')
  }
  throw err
}

async function sourcePageCount(bytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount()
  } catch {
    return 0
  }
}

export async function pdfToOffice(
  bytes: Uint8Array,
  name: string,
  target: OfficeTarget,
  password?: string,
): Promise<OfficeResult> {
  if (target === 'hwp' || target === 'hwpx') {
    try {
      const { blob, stats } = await pdfToHwp(toFile(bytes, name), target, { password })
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        sourcePages: await sourcePageCount(bytes),
        emptyPages: stats.emptyPages,
        tables: stats.tables,
        images: stats.images,
        pages: stats.pages,
        lost: stats.lost,
        verified: stats.verified,
        check: stats.verified ? `reopened, all ${stats.paragraphs} paragraphs there` : 'reopened, paragraph count differs. Check in Hangul',
      }
    } catch (err) {
      explain(err, password)
    }
  }

  let layout
  try {
    // Word wants paragraphs and Excel wants tables, but both are better off
    // with both: a table in a Word file stays a table. Same call the site makes.
    layout = await extractPdfLayout(toFile(bytes, name), { password, detectTables: true, extractImages: true })
  } catch (err) {
    explain(err, password)
  }

  const base = {
    sourcePages: layout.pageCount,
    emptyPages: layout.emptyPages,
    tables: layout.tableCount,
    images: layout.imageCount,
    imagesDropped: layout.imagesDropped,
  }

  if (target === 'xlsx') {
    const out = new Uint8Array(await (await layoutToXlsx(layout, { sheetName: (page) => `Page ${page}` })).arrayBuffer())
    const expected = layout.pages.filter((page) => page.blocks.length > 0).length || 1
    const XLSX = await import('xlsx')
    const sheets = XLSX.read(out, { type: 'array' }).SheetNames.length
    return {
      ...base,
      bytes: out,
      verified: sheets === expected,
      check: sheets === expected ? `reopened, ${sheets} ${sheets === 1 ? 'sheet' : 'sheets'}` : `reopened, ${sheets} sheets where ${expected} were written`,
    }
  }

  const out = new Uint8Array(await (await layoutToDocx(layout)).arrayBuffer())
  const text = (await mammoth.extractRawText({ buffer: Buffer.from(out) })).value
  const characters = text.replace(/\s/g, '').length
  return {
    ...base,
    bytes: out,
    verified: characters > 0,
    check: characters > 0 ? `reopened, ${characters.toLocaleString('en-US')} characters of text` : 'reopened, but no text came back',
  }
}
