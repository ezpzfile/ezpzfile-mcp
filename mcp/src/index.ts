#!/usr/bin/env node
/**
 * ezpzfile MCP server.
 *
 * The point is that an agent stops writing throwaway conversion code every
 * time it needs to touch a file. Everything runs on this machine and no file
 * is ever sent anywhere, so confidential documents are fine.
 *
 * Eleven tools, not forty. Tool definitions sit in the model's context
 * for every session. A long list would eat the tokens this server exists to
 * save, so related jobs share one tool and are told apart by `op` or `to`.
 * When a capability is added, add a value, not a tool.
 */
import './quiet'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { PDFDocument, degrees } from 'pdf-lib'
import { z } from 'zod'
import { convertContainer, hwpToDocx, hwpToPdf, readDocument } from './convert'
import { readDocx, readEml, readPdfText, readTable, tableTo } from './docs'
import { pdfToOffice } from './fromPdf'
import { heicToPng, isHeif } from './heic'
import * as image from './image'
import { jtdToDocx, jtdToPdf, readJtd } from './jtd'
import { removeBackground } from './matte'
import { compressPdf, imagesToPdf, looksEncrypted, protectPdf, renderPages, unlockPdf, warmQpdf } from './pdfx'
import { makeQr } from './qr'
import { readMetadata } from './meta'
import { explainProblem, replaceText } from './pdfText'
import { readXdw, xdwToPdf } from './xdw'
import { redactPdf } from './redact'
import { CAD_EXT, drawingPdf, drawingPng, drawingSvg, drawingText } from './cad'
import { registerDocTools } from './docTools'
import { registerProfiles } from './profiles'
import { runWasiCommand } from './designEngine'
import { registerCommandResources } from './commandsResource'
import { absolutePath } from './paths'
import { fail, formatBytes, ok, outputPath, suffixedPath } from './result'

// build.mjs writes package.json's version in here, so what the handshake
// announces cannot drift away from what was published.
declare const __PKG_VERSION__: string

const server = new McpServer({ name: 'ezpzfile', version: __PKG_VERSION__ })

const read = (p: string) => new Uint8Array(readFileSync(absolutePath(p)))

/**
 * Page numbers that do not exist used to be dropped without a word, so
 * `extract` on page 99 of a one page file wrote an empty PDF and reported
 * success. An agent then carried that empty file into the next step. Say no
 * instead.
 */
function checkPages(label: string, list: number[] | undefined, total: number): Error | null {
  if (!list || list.length === 0) return null
  const bad = [...new Set(list.filter((n) => !Number.isInteger(n) || n < 1 || n > total))].sort((a, b) => a - b)
  if (bad.length === 0) return null
  const plural = total === 1 ? '1 page' : `${total} pages`
  return new Error(
    `${label}: ${bad.length > 1 ? 'pages' : 'page'} ${bad.join(', ')} ${bad.length > 1 ? 'do' : 'does'} not exist. This PDF has ${plural}.`,
  )
}
const ext = (p: string) => extname(p).toLowerCase().replace(/^\./, '')
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'heif', 'bmp'])
const JTD_EXT = new Set(['jtd', 'jtt'])
const XDW_EXT = new Set(['xdw', 'xbd'])
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pageList = (pages: number[]) => (pages.length > 12 ? `${pages.slice(0, 12).join(', ')} and ${pages.length - 12} more` : pages.join(', '))
const TABLE_EXT = new Set(['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv', 'txt', 'psv'])

/* ------------------------------------------------------------------ doc_read */

server.registerTool(
  'doc_read',
  {
    title: 'Read document',
    description:
      'Extract the text of a document: DOCX, PDF, EML email, HWP and HWPX (Korean, no Hancom Office needed), JTD (Ichitaro), XDW and XBD (DocuWorks). format metadata lists what a file records about itself instead: camera, GPS, author, dates.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file. Relative paths are refused'),
      format: z
        .enum(['text', 'markdown', 'json', 'metadata'])
        .optional()
        .describe(
          'markdown keeps headings, lists and tables (DOCX, JTD, HWP/HWPX: tables by cell address, merged or nested tables as HTML <table>, text boxes in place). json: HWP/HWPX structure (paragraphs, tables with cell row/col/span, text boxes). metadata: photos, PDF, Office, HWPX, JTD. Default text',
        ),
      password: z.string().optional().describe('Only for encrypted PDF, HWP or HWPX'),
    },
  },
  async ({ path, format, password }) => {
    try {
      const file = absolutePath(path)
      const bytes = read(file)
      const kind = ext(file)

      if (format === 'metadata') {
        const { text, data } = await readMetadata(bytes, basename(file), kind)
        return ok(text, data)
      }
      if (format === 'json' && kind !== 'hwp' && kind !== 'hwpx') {
        return fail(new Error('format json is for HWP and HWPX. Use markdown for the other formats.'))
      }

      if (CAD_EXT.has(kind)) {
        const r = await drawingText(bytes, basename(file))
        if (!r.texts) return ok(`${basename(file)}: no text in this drawing${r.sheets ? '' : ' (a 3D model: doc_inspect lists its elements)'}.`, { sheets: r.sheets, texts: 0 })
        return ok(r.text, { sheets: r.sheets, texts: r.texts })
      }

      if (JTD_EXT.has(kind)) {
        const { text, summary, sheets } = await readJtd(bytes, format === 'markdown' ? 'markdown' : 'text')
        return ok(text, {
          format: 'jtd',
          characters: text.length,
          sheets,
          recordedPages: summary.pages ?? null,
          author: summary.author ?? null,
          saved: summary.saved ?? null,
          application: summary.application ?? null,
        })
      }

      if (XDW_EXT.has(kind)) {
        const result = await readXdw(bytes, format === 'markdown' ? 'markdown' : 'text')
        const note =
          result.emptyPages.length > 0
            ? `\n\n[${result.emptyPages.length} of ${result.pages} pages have no text (likely scanned): ${pageList(result.emptyPages)}]`
            : ''
        return ok(result.text + note, {
          format: result.binder ? 'xbd' : 'xdw',
          pages: result.pages,
          characters: result.text.length,
          emptyPages: result.emptyPages,
          binder: result.binder ? result.binder.docs.map((d) => ({ name: d.name, firstPage: d.first_page + 1, pages: d.pages })) : null,
          signed: result.signed,
        })
      }

      if (kind === 'hwp' || kind === 'hwpx') {
        const result = await readDocument(bytes, password, format === 'markdown' || format === 'json' ? format : 'text')
        return {
          content: [{ type: 'text' as const, text: result.text }],
          structuredContent: {
            format: kind,
            pages: result.pages,
            characters: result.text.length,
            fontsUsed: result.fontsUsed,
            tables: result.structure?.tables ?? 0,
            nestedTables: result.structure?.nestedTables ?? 0,
            mergedCells: result.structure?.mergedCells ?? 0,
            textBoxes: result.structure?.textBoxes ?? 0,
          },
        }
      }
      if (kind === 'docx') {
        const text = await readDocx(bytes, format === 'markdown' ? 'markdown' : 'text')
        return ok(text, { format: 'docx', characters: text.length })
      }
      if (kind === 'eml') {
        const { text, summary } = await readEml(bytes, basename(file))
        return ok(text, { format: 'eml', characters: text.length, ...summary })
      }
      if (kind === 'pdf') {
        const result = await readPdfText(bytes, password)
        const note =
          result.emptyPages.length > 0
            ? `\n\n[${result.emptyPages.length} of ${result.pages} pages have no text layer (likely scanned): ${result.emptyPages.join(', ')}]`
            : ''
        return ok(result.text + note, {
          format: 'pdf',
          pages: result.pages,
          characters: result.text.length,
          emptyPages: result.emptyPages,
        })
      }
      return fail(
        new Error(
          `Unsupported file type .${kind}. doc_read handles hwp, hwpx, docx, pdf, eml, jtd, xdw and xbd. For photos and other files, format metadata reads their properties.`,
        ),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

/* ------------------------------------------------------------------ doc_convert */

server.registerTool(
  'doc_convert',
  {
    title: 'Convert document',
    description:
      'Convert between file formats. PDF to jpg or png pages, or to docx, xlsx, hwp, hwpx (rebuilt from the text layer). Images, HEIC included, to pdf (several paths become one PDF). XLSX/CSV to csv or json. HWP/HWPX to pdf, hwp, hwpx, or docx (tables, merged cells and nested tables kept). JTD to docx or pdf. XDW/XBD to pdf. CAD drawings (DWG, DXF, JWW, …) to pdf (every sheet, vector), png or svg (one sheet: pages [n]). Every output is reopened and checked, and the result reports what could not be carried over.',
    inputSchema: {
      path: z.string().describe('Absolute path of the source file. Relative paths are refused'),
      to: z.enum(['pdf', 'docx', 'xlsx', 'hwp', 'hwpx', 'jpg', 'png', 'svg', 'csv', 'json']).describe('Target format'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Additional inputs. Only for images to pdf: all images are bundled in order, path first'),
      out: z
        .string()
        .optional()
        .describe('Output path. For PDF to images this is a directory. Default: next to the source'),
      output: z.string().optional().describe('Same as out (either name works)'),
      pages: z.array(z.number().int().positive()).optional().describe('PDF to images: which pages, 1-based. Default all'),
      dpi: z.number().int().positive().optional().describe('PDF to images: resolution. Default 144'),
      sheet: z.union([z.string(), z.number().int().nonnegative()]).optional().describe('Table export: sheet name or 0-based index. Default first'),
      pageSize: z.enum(['fit', 'a4']).optional().describe('Images to pdf: fit makes each page the image size, a4 centers on A4. Default fit'),
      password: z.string().optional(),
    },
  },
  async ({ path, to, paths, out: outArg, output, pages, dpi, sheet, pageSize, password }) => {
    // 0.4.0 은 out 만 읽고 output 은 말없이 버려 원본 옆에 썼다(2026-11-05 신고). 둘 다 받는다.
    const out = outArg ?? output
    try {
      const file = absolutePath(path)
      const kind = ext(file)
      const bytes = read(file)
      const title = basename(file, extname(file))

      // CAD drawings: every sheet to a vector PDF, or one sheet to PNG or SVG.
      if (CAD_EXT.has(kind)) {
        if (to === 'pdf') {
          const target = outputPath(file, 'pdf', out)
          const r = await drawingPdf(bytes, basename(file), {})
          writeFileSync(target, r.pdf)
          const back = await PDFDocument.load(r.pdf)
          return ok(`${target}\n${plural(r.pages, 'sheet')} · reopened, ${back.getPageCount()} pages${r.missingGlyphs ? ` · ${r.missingGlyphs} characters no bundled font has` : ''}`, { path: target, pages: r.pages, reopenedPages: back.getPageCount(), missingGlyphs: r.missingGlyphs })
        }
        if (to === 'png' || to === 'svg') {
          const target = outputPath(file, to, out)
          const sheet = (pages?.[0] ?? 1) - 1
          if (to === 'svg') writeFileSync(target, await drawingSvg(bytes, basename(file), { sheet }))
          else {
            const r = await drawingPng(bytes, basename(file), { sheet, px: dpi ? Math.round(dpi * 11.7) : 2400 })
            writeFileSync(target, r.png)
            return ok(`${target}\nsheet ${sheet + 1} of ${r.sheets} · ${r.width}x${r.height}`, { path: target, width: r.width, height: r.height, sheets: r.sheets })
          }
          return ok(`${target}\nsheet ${sheet + 1}`, { path: target })
        }
        return fail(new Error(`A CAD drawing can be converted to pdf, png or svg, not ${to}.`))
      }

      // Ichitaro: our JTD engine lays the pages out, the same one ezpzfile.com/ja/jtd-editor runs.
      if (JTD_EXT.has(kind)) {
        // Ichitaro and this layout break lines and pages their own way. Say so when the counts differ.
        const drift = (made: number, recorded?: number) =>
          recorded && recorded !== made ? `Ichitaro recorded ${plural(recorded, 'page')}; line and page breaks here can differ from Ichitaro's own` : null
        if (to === 'docx') {
          const target = outputPath(file, 'docx', out)
          const made = await jtdToDocx(bytes)
          writeFileSync(target, made.docx)
          const notes = [
            plural(made.pages, 'page'),
            made.reopenedCharacters > 0
              ? `reopened, ${made.reopenedCharacters.toLocaleString('en-US')} of ${made.characters.toLocaleString('en-US')} characters there`
              : 'reopened, but no text came back',
            drift(made.pages, made.recordedPages),
          ].filter(Boolean)
          return ok(`${target}\n${notes.join(' · ')}`, {
            path: target,
            pages: made.pages,
            recordedPages: made.recordedPages ?? null,
            characters: made.characters,
            reopenedCharacters: made.reopenedCharacters,
          })
        }
        if (to === 'pdf') {
          const target = outputPath(file, 'pdf', out)
          const made = await jtdToPdf(bytes, title)
          writeFileSync(target, made.pdf)
          const notes = [
            plural(made.pages, 'page'),
            made.reopenedPages === made.pages ? 'reopened, page count matches' : `reopened, ${made.reopenedPages} pages where ${made.pages} were drawn`,
            'pages are pictures with an invisible text layer, so the text can still be searched and copied',
            drift(made.pages, made.recordedPages),
          ].filter(Boolean)
          return ok(`${target}\n${notes.join(' · ')}`, {
            path: target,
            pages: made.pages,
            recordedPages: made.recordedPages ?? null,
            pageMatch: made.reopenedPages === made.pages,
          })
        }
        return fail(new Error(`Ichitaro (JTD) can be converted to docx or pdf, not ${to}. doc_read gives its text.`))
      }

      // DocuWorks: our XDW engine, the same one ezpzfile.com/ja/xdw-editor runs.
      if (XDW_EXT.has(kind)) {
        if (to !== 'pdf') return fail(new Error(`DocuWorks (XDW, XBD) can be converted to pdf, not ${to}. doc_read gives its text.`))
        const target = outputPath(file, 'pdf', out)
        const made = await xdwToPdf(bytes, title)
        writeFileSync(target, made.pdf)
        const notes = [
          plural(made.pages, 'page'),
          made.binderDocs ? `${plural(made.binderDocs, 'document')} from the binder, in order` : null,
          made.reopenedPages === made.pages ? 'reopened, page count matches' : `reopened, ${made.reopenedPages} pages where ${made.pages} were drawn`,
          made.missingPictures ? `${plural(made.missingPictures, 'picture')} could not be decoded and are missing` : null,
          made.signed ? 'the DocuWorks signature does not carry over to a PDF' : null,
        ].filter(Boolean)
        return ok(`${target}\n${notes.join(' · ')}`, {
          path: target,
          pages: made.pages,
          pageMatch: made.reopenedPages === made.pages,
          missingPictures: made.missingPictures,
          binderDocs: made.binderDocs,
          signed: made.signed,
        })
      }

      // PDF back into an editable document. A reconstruction: the PDF never said what was a paragraph.
      if (kind === 'pdf' && (to === 'docx' || to === 'xlsx' || to === 'hwp' || to === 'hwpx')) {
        const target = outputPath(file, to, out)
        const made = await pdfToOffice(bytes, basename(file), to, password)
        writeFileSync(target, made.bytes)
        const notes = [
          `${plural(made.sourcePages, 'page')} read`,
          made.pages !== undefined ? `${plural(made.pages, 'page')} written` : null,
          plural(made.tables, 'table'),
          plural(made.images, 'picture'),
          made.check,
          made.lost ? `${plural(made.lost, 'element')} could not be carried over` : null,
          made.emptyPages.length ? `no text on ${plural(made.emptyPages.length, 'page')} (${pageList(made.emptyPages)}), likely scanned, left out` : null,
          made.imagesDropped ? 'some pictures could not be taken out, the text is complete' : null,
        ].filter(Boolean)
        return ok(`${target}\n${notes.join(' · ')}`, {
          path: target,
          sourcePages: made.sourcePages,
          pages: made.pages ?? null,
          tables: made.tables,
          images: made.images,
          emptyPages: made.emptyPages,
          lost: made.lost ?? null,
          verified: made.verified,
        })
      }

      // HWP and HWPX: the original engine path, verified by reopening.
      if (kind === 'hwp' || kind === 'hwpx') {
        if (to === 'pdf') {
          const target = outputPath(file, 'pdf', out)
          const { pdf, stats } = await hwpToPdf(bytes, password)
          writeFileSync(target, pdf)
          const notes = [
            `${stats.pages} pages`,
            stats.systemFonts?.length ? `system fonts used for some characters: ${stats.systemFonts.join(', ')}` : null,
            stats.missingGlyphs
              ? `${stats.missingGlyphs} characters could not be drawn (no font has them): ${stats.missingChars?.slice(0, 40).join(', ')}`
              : null,
            stats.skipped ? `${stats.skipped} elements could not be carried over` : null,
          ].filter(Boolean)
          return ok(`${target}\n${notes.join(' · ')}`, { path: target, ...stats })
        }
        if (to === 'hwp' || to === 'hwpx') {
          const target = outputPath(file, to, out)
          const { out: bytesOut, stats } = await convertContainer(bytes, to, password)
          writeFileSync(target, bytesOut)
          const notes = [
            `${stats.pages} pages`,
            stats.lost ? `${stats.lost} elements could not be carried over` : 'no loss reported',
            stats.pageMatch ? 'reopened, page count matches' : 'reopened, page count differs. Check in Hangul',
          ]
          return ok(`${target}\n${notes.join(' · ')}`, { path: target, ...stats })
        }
        if (to === 'docx') {
          const target = outputPath(file, 'docx', out)
          const { docx, stats } = await hwpToDocx(bytes, password)
          writeFileSync(target, docx)
          const notes = [
            `${stats.tables} tables, ${stats.mergedCells} merged cells, ${stats.textBoxes} text boxes`,
            stats.tablesBack === stats.tables ? 'reopened, table count matches' : `reopened, ${stats.tablesBack} of ${stats.tables} tables found`,
            'text and table structure only: fonts, sizes and page layout are not carried over',
          ]
          return ok(`${target}\n${notes.join(' · ')}`, { path: target, ...stats })
        }
        return fail(new Error(`HWP/HWPX can be converted to pdf, docx, hwp or hwpx, not ${to}. doc_read gives its text.`))
      }

      // PDF pages to images.
      if (kind === 'pdf' && (to === 'jpg' || to === 'png')) {
        const dir = out ? absolutePath(out, 'out') : join(dirname(file), basename(file, extname(file)))
        mkdirSync(dir, { recursive: true })
        const rendered = await renderPages(bytes, {
          pages,
          dpi: dpi ?? 144,
          format: to === 'jpg' ? 'jpeg' : 'png',
          password,
        })
        const stem = basename(file, extname(file))
        const written = rendered.map((r) => {
          const target = join(dir, `${stem}-${String(r.page).padStart(3, '0')}.${to}`)
          writeFileSync(target, r.bytes)
          return { path: target, page: r.page, width: r.width, height: r.height, bytes: r.bytes.length }
        })
        const first = written[0]
        return ok(
          `${dir}\n${written.length} pages rendered at ${dpi ?? 144} dpi${first ? ` (${first.width}×${first.height}px)` : ''}`,
          { dir, files: written, pages: written.length },
        )
      }

      // Tables to csv or json.
      if (to === 'csv' || to === 'json') {
        if (!TABLE_EXT.has(kind)) return fail(new Error(`${to} export needs a spreadsheet or CSV input, got .${kind}.`))
        const sheets = await readTable(bytes, basename(file))
        const result = await tableTo(sheets, to, sheet)
        const target = outputPath(file, to, out)
        writeFileSync(target, result.bytes)
        const notes = [
          `sheet "${result.sheet}"`,
          `${result.rows} rows × ${result.columns} columns`,
          sheets.isText ? `read as ${sheets.encoding}${sheets.confident ? '' : ' (guessed)'}` : null,
          sheets.sheets.length > 1 ? `${sheets.sheets.length} sheets in source` : null,
        ].filter(Boolean)
        return ok(`${target}\n${notes.join(' · ')}`, {
          path: target,
          sheet: result.sheet,
          rows: result.rows,
          columns: result.columns,
          sheets: sheets.sheets.map((s) => s.name),
          encoding: sheets.encoding,
        })
      }

      // Images to one PDF.
      if (IMAGE_EXT.has(kind) && to === 'pdf') {
        const inputs = [file, ...(paths ?? []).map((p, i) => absolutePath(p, `paths[${i}]`))]
        const target = outputPath(file, 'pdf', out)
        // HEIC goes through libheif first: pdf-lib embeds only PNG and JPEG, and sharp cannot decode HEVC.
        const pictures: Uint8Array[] = []
        for (const input of inputs) pictures.push((await heicToPng(read(input))).bytes)
        const { pdf, pages: count } = await imagesToPdf(pictures, { pageSize: pageSize ?? 'fit', margin: 36 })
        writeFileSync(target, pdf)
        const check = await PDFDocument.load(pdf)
        return ok(`${target}\n${count} pages from ${inputs.length} images · reopened, ${check.getPageCount()} pages`, {
          path: target,
          pages: count,
          inputs: inputs.length,
          pageMatch: check.getPageCount() === inputs.length,
        })
      }

      if (kind === 'pdf') return fail(new Error(`A PDF can be converted to jpg, png, docx, xlsx, hwp or hwpx, not ${to}.`))
      return fail(new Error(`Cannot convert .${kind} to ${to}.`))
    } catch (err) {
      return fail(err)
    }
  },
)

/* ------------------------------------------------------------------ pdf_edit */

server.registerTool(
  'pdf_edit',
  {
    title: 'Edit PDF',
    description:
      'Edit PDF files: merge, extract, delete, rotate, reorder, split, compress (lossless), protect (set password), unlock (remove password), replace_text (edits the text in place, font kept), redact (removes what is under boxes or every occurrence of find: the page is redrawn as a picture, so the text is gone from the file, then checked). Page numbers are 1-based.',
    inputSchema: {
      op: z.enum(['merge', 'extract', 'delete', 'rotate', 'reorder', 'split', 'compress', 'protect', 'unlock', 'replace_text', 'redact']),
      paths: z.array(z.string()).describe('Absolute paths. merge takes several files, every other op takes one'),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe('extract, delete, rotate, replace_text: pages to act on. Default all'),
      find: z.union([z.string(), z.array(z.string())]).optional().describe('replace_text: exact text, case sensitive. redact: a phrase or a list of phrases to remove wherever the text layer has them'),
      boxes: z
        .array(z.object({ page: z.number().int().positive(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
        .optional()
        .describe('redact: areas to remove, in points from the top-left of the page as displayed (A4 is 595 x 842)'),
      replace: z.string().optional().describe('replace_text: new text, one line. Empty deletes'),
      degrees: z.number().int().optional().describe('rotate: multiple of 90. Default 90'),
      order: z.array(z.number().int().positive()).optional().describe('reorder: full new page order, e.g. [3,1,2]'),
      at: z
        .array(z.number().int().positive())
        .optional()
        .describe('split: page numbers that start a new file, e.g. [4,8] makes 1-3, 4-7, 8-end'),
      password: z.string().optional().describe('protect: password to set. unlock: password to remove. others: password of an encrypted input'),
      ownerPassword: z.string().optional().describe('protect: separate owner password. Default same as password'),
      allowPrint: z.boolean().optional().describe('protect: allow printing. Default true'),
      allowCopy: z.boolean().optional().describe('protect: allow copying text. Default true'),
      out: z.string().optional().describe('Absolute output path. split: output directory'),
    },
  },
  async ({ op, paths, pages, find: findArg, boxes, replace, degrees: angle, order, at, password, ownerPassword, allowPrint, allowCopy, out }) => {
    try {
      const inputs = paths.map((p, i) => absolutePath(p, `paths[${i}]`))
      const first = inputs[0]
      if (!first) return fail(new Error('paths must contain at least one file.'))
      const target = suffixedPath(first, op === 'replace_text' ? 'replaced' : op === 'redact' ? 'redacted' : op, 'pdf', out)

      if (op === 'redact') {
        const phrases = findArg === undefined ? [] : Array.isArray(findArg) ? findArg : [findArg]
        const r = await redactPdf(read(first), { boxes, find: phrases.filter(Boolean), password })
        writeFileSync(target, r.pdf)
        const missed = Object.entries(r.found).filter(([, n]) => n === 0).map(([f]) => `"${f}"`)
        const notes = [
          `${plural(r.boxes, 'area')} removed on ${r.redactedPages.length > 1 ? 'pages' : 'page'} ${pageList(r.redactedPages)} (redrawn as pictures, text layer gone there)`,
          missed.length ? `not found: ${missed.join(', ')}` : null,
          r.verify.allConfirmed ? 'reopened: nothing left to extract on those pages' : `reopened: CHECK, ${JSON.stringify(r.verify)}`,
        ].filter(Boolean)
        return ok(`${target}\n${notes.join(' · ')}`, { path: target, pages: r.pages, redactedPages: r.redactedPages, boxes: r.boxes, found: r.found, verify: r.verify })
      }
      const find = Array.isArray(findArg) ? findArg[0] : findArg

      if (op === 'merge') {
        const merged = await PDFDocument.create()
        for (const input of inputs) {
          const src = await PDFDocument.load(readFileSync(input), { ignoreEncryption: true })
          const copied = await merged.copyPages(src, src.getPageIndices())
          for (const page of copied) merged.addPage(page)
        }
        writeFileSync(target, await merged.save())
        return ok(`${target}\n${merged.getPageCount()} pages from ${inputs.length} files`, {
          path: target,
          pages: merged.getPageCount(),
          inputs: inputs.length,
        })
      }

      const source = read(first)

      if (op === 'replace_text') {
        if (find === undefined || find === '') return fail(new Error('replace_text needs find: the exact text to look for.'))
        if (replace === undefined) return fail(new Error('replace_text needs replace: the new text, or an empty string to delete.'))
        if (looksEncrypted(source)) {
          return fail(new Error('This PDF is encrypted, and its text cannot be changed while it is. Remove the password with op unlock first, then replace text in the unlocked copy.'))
        }
        const total = (await PDFDocument.load(source, { ignoreEncryption: true })).getPageCount()
        const range = checkPages('pages', pages, total)
        if (range) return fail(range)
        const made = await replaceText(source, basename(first), find, replace, pages)
        const quoted = JSON.stringify(find)
        if (made.found === 0) {
          return fail(new Error(`${quoted} does not appear in the text of this PDF${pages?.length ? ` on pages ${pageList(pages)}` : ''}. doc_read shows the text as the PDF stores it. Scanned pages have no text to change.`))
        }
        const failures = made.failed.map((f) => `page ${f.page}: "${f.text}" (${explainProblem(f.why)})`)
        if (made.replaced === 0) {
          const why = [
            made.split ? `${plural(made.split, 'occurrence')} ${made.split === 1 ? 'is' : 'are'} split across separately drawn pieces of text` : null,
            ...failures,
          ].filter(Boolean)
          return fail(new Error(`Found ${quoted} ${made.found === 1 ? 'once' : `${made.found} times`} but could not change it in place, so no file was written. ${why.join('; ')}.`))
        }
        writeFileSync(target, made.bytes)
        const notes = [
          `replaced ${made.replaced} of ${made.found}`,
          `on ${plural(made.pagesChanged.length, 'page')} (${pageList(made.pagesChanged)})`,
          made.substituted ? `${made.substituted} needed a character the original font lacks, so ${made.sameFonts?.length ? `the same font (${made.sameFonts.join(', ')}) was embedded for it` : 'an embedded font draws that line'}` : null,
          made.split ? `${made.split} left alone: split across separately drawn pieces of text` : null,
          made.failed.length ? `${made.failed.length} could not be rewritten: ${failures.slice(0, 3).join('; ')}` : null,
          `reopened, ${made.remaining} left`,
        ].filter(Boolean)
        return ok(`${target}\n${notes.join(' · ')}`, {
          path: target,
          found: made.found,
          replaced: made.replaced,
          substituted: made.substituted,
          split: made.split,
          failed: made.failed,
          remaining: made.remaining,
          pages: made.pagesChanged,
        })
      }

      if (op === 'protect') {
        if (!password) return fail(new Error('protect needs a password.'))
        const outBytes = await protectPdf(source, { password, ownerPassword, allowPrint, allowCopy })
        writeFileSync(target, outBytes)
        return ok(`${target}\nAES-256 · print ${allowPrint === false ? 'blocked' : 'allowed'} · copy ${allowCopy === false ? 'blocked' : 'allowed'}`, {
          path: target,
          encrypted: looksEncrypted(outBytes),
          bytes: outBytes.length,
        })
      }
      if (op === 'unlock') {
        if (!password) return fail(new Error('unlock needs the current password.'))
        const outBytes = await unlockPdf(source, password)
        writeFileSync(target, outBytes)
        const check = await PDFDocument.load(outBytes)
        return ok(`${target}\n${check.getPageCount()} pages · password removed`, {
          path: target,
          pages: check.getPageCount(),
          encrypted: looksEncrypted(outBytes),
        })
      }
      if (op === 'compress') {
        const outBytes = await compressPdf(source, password)
        const keep = outBytes.length < source.length
        const finalBytes = keep ? outBytes : source
        writeFileSync(target, finalBytes)
        const saved = source.length - finalBytes.length
        return ok(
          `${target}\n${formatBytes(source.length)} → ${formatBytes(finalBytes.length)}${keep ? ` (${Math.round((saved / source.length) * 100)}% smaller, lossless)` : ' (already compact, copied unchanged)'}`,
          { path: target, before: source.length, after: finalBytes.length, saved, usedOriginal: !keep },
        )
      }

      const doc = await PDFDocument.load(source, { ignoreEncryption: true })
      const total = doc.getPageCount()

      const range =
        checkPages('pages', op === 'extract' || op === 'delete' || op === 'rotate' ? pages : undefined, total) ??
        checkPages('order', op === 'reorder' ? order : undefined, total) ??
        checkPages('at', op === 'split' ? at : undefined, total)
      if (range) return fail(range)

      const picked = (pages ?? Array.from({ length: total }, (_, i) => i + 1)).map((n) => n - 1)

      if (op === 'extract' || op === 'reorder') {
        const indices = op === 'reorder' ? (order ?? []).map((n) => n - 1) : picked
        if (indices.length === 0) return fail(new Error(`${op} produced no pages. Give at least one page number.`))
        if (op === 'reorder' && indices.length === 0) return fail(new Error('reorder needs order, the full list of pages in their new sequence.'))
        const made = await PDFDocument.create()
        const copied = await made.copyPages(doc, indices)
        for (const page of copied) made.addPage(page)
        writeFileSync(target, await made.save())
        return ok(`${target}\n${made.getPageCount()} pages${op === 'reorder' && indices.length !== total ? ` (source had ${total})` : ''}`, {
          path: target,
          pages: made.getPageCount(),
        })
      }

      if (op === 'delete') {
        if (picked.length >= total) return fail(new Error('Deleting every page would leave an empty PDF.'))
        for (const index of [...picked].sort((a, b) => b - a)) doc.removePage(index)
        writeFileSync(target, await doc.save())
        return ok(`${target}\n${doc.getPageCount()} pages left`, { path: target, pages: doc.getPageCount() })
      }

      if (op === 'rotate') {
        const turn = angle ?? 90
        for (const index of picked) {
          const page = doc.getPage(index)
          page.setRotation(degrees((((page.getRotation().angle + turn) % 360) + 360) % 360))
        }
        writeFileSync(target, await doc.save())
        return ok(`${target}\n${picked.length} pages rotated by ${turn}°`, { path: target, pages: doc.getPageCount() })
      }

      // split
      // Page 1 starts the first file on its own, so asking to cut there changes
      // nothing. Drop it rather than producing an empty leading file.
      const cuts = [...new Set((at ?? []).filter((n) => n > 1))].sort((a, b) => a - b)
      if (cuts.length === 0) {
        return fail(
          new Error(
            at?.length
              ? 'split: at must name a page after the first, e.g. [4,8] makes 1-3, 4-7, 8-end.'
              : 'split needs at: page numbers where a new file starts, e.g. [4,8].',
          ),
        )
      }
      const dir = out ? absolutePath(out, 'out') : dirname(first)
      mkdirSync(dir, { recursive: true })
      const stem = basename(first, extname(first))
      const bounds = [1, ...cuts, total + 1]
      const files: { path: string; pages: string; count: number }[] = []
      for (let i = 0; i < bounds.length - 1; i += 1) {
        const from = bounds[i]!
        const to = bounds[i + 1]! - 1
        const part = await PDFDocument.create()
        const copied = await part.copyPages(doc, Array.from({ length: to - from + 1 }, (_, k) => from - 1 + k))
        for (const page of copied) part.addPage(page)
        const partPath = join(dir, `${stem}-${i + 1}.pdf`)
        writeFileSync(partPath, await part.save())
        files.push({ path: partPath, pages: `${from}-${to}`, count: to - from + 1 })
      }
      return ok(
        `${dir}\n${files.length} files: ${files.map((f) => `${basename(f.path)} (${f.pages})`).join(', ')}`,
        { dir, files, sourcePages: total },
      )
    } catch (err) {
      return fail(err)
    }
  },
)

/* ------------------------------------------------------------------ pdf_info */

server.registerTool(
  'pdf_info',
  {
    title: 'PDF info',
    description: 'Page count, page sizes, encryption flag and document metadata. Use to verify a conversion.',
    inputSchema: { path: z.string().describe('Absolute path of the PDF. Relative paths are refused') },
  },
  async ({ path }) => {
    try {
      const bytes = read(path)
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const sizes = doc.getPages().map((p) => {
        const { width, height } = p.getSize()
        return `${Math.round(width)}×${Math.round(height)}`
      })
      const unique = [...new Set(sizes)]
      const encrypted = looksEncrypted(bytes)
      return ok(`${doc.getPageCount()} pages · ${unique.join(', ')} pt · ${formatBytes(bytes.length)}${encrypted ? ' · encrypted' : ''}`, {
        pages: doc.getPageCount(),
        sizes: unique,
        bytes: bytes.length,
        encrypted,
        title: doc.getTitle() ?? null,
        author: doc.getAuthor() ?? null,
        producer: doc.getProducer() ?? null,
      })
    } catch (err) {
      return fail(err)
    }
  },
)

/* ------------------------------------------------------------------ image_edit */

server.registerTool(
  'image_edit',
  {
    title: 'Edit image',
    description:
      'Resize, compress, convert (jpeg, png, webp), strip metadata (EXIF, GPS, XMP) or remove the background from an image. Reads HEIC. strip_metadata never re-encodes pixels. remove_background downloads a 4.4MB model once per machine and always writes PNG. Returns the real output dimensions and byte size.',
    inputSchema: {
      path: z.string().describe('Absolute path of the source image. Relative paths are refused'),
      op: z.enum(['resize', 'compress', 'convert', 'strip_metadata', 'remove_background']),
      width: z.number().int().positive().optional().describe('resize: give width or height alone to keep the aspect ratio'),
      height: z.number().int().positive().optional(),
      quality: z.number().min(1).max(100).optional().describe('compress, convert, resize: 1-100. Default 85 (compress 75)'),
      format: z.enum(['jpeg', 'png', 'webp']).optional().describe('convert: target format. Others: default keeps the source format, HEIC becomes jpeg'),
      background: z.string().optional().describe('remove_background: fill colour behind the subject, for example #ffffff. Default transparent'),
      out: z.string().optional(),
    },
  },
  async ({ path, op, width, height, quality, format, background, out }) => {
    try {
      const file = absolutePath(path)
      const original = read(file)

      if (op === 'strip_metadata') {
        if (isHeif(original.subarray(0, 12))) {
          return fail(
            new Error('Metadata cannot be cut out of a HEIC file without re-encoding it. Use op convert instead: the converted copy carries no metadata at all.'),
          )
        }
        const result = await image.strip(original, basename(file))
        const target = suffixedPath(file, 'clean', ext(file) || result.format, out)
        writeFileSync(target, result.bytes)
        const what = result.tags.length ? result.tags.join(', ') : 'nothing found'
        return ok(`${target}\nremoved: ${what} · ${formatBytes(result.removed)} smaller · pixels untouched`, {
          path: target,
          format: result.format,
          removed: result.tags,
          removedBytes: result.removed,
          before: original.length,
          after: result.bytes.length,
        })
      }

      // HEIC (iPhone) is decoded by libheif, because sharp cannot decode HEVC. HEIC
      // cannot be written back either, so a HEIC source comes out as JPEG unless
      // format says otherwise.
      const { bytes, heic } = await heicToPng(original)

      if (op === 'remove_background') {
        const result = await removeBackground(bytes, background ? { background } : {})
        // Always PNG: JPEG has no alpha, and a half transparent edge saved as
        // JPEG turns into a black fringe.
        const target = suffixedPath(file, 'cutout', 'png', out)
        writeFileSync(target, result.bytes)
        return ok(
          `${target}\n${result.width}×${result.height} · ${formatBytes(result.bytes.length)} · ${background ? `background ${background}` : 'transparent background'} · ${result.ms}ms`,
          {
            path: target,
            width: result.width,
            height: result.height,
            bytes: result.bytes.length,
            background: background ?? null,
            ms: result.ms,
          },
        )
      }

      const source = heic ? null : await image.detectFormat(bytes)
      const target_format = format ?? (heic ? 'jpeg' : source)
      if (!target_format) {
        return fail(new Error('Could not decode the image, or its format cannot be written. Use format to choose jpeg, png or webp.'))
      }
      const extOut = target_format === 'jpeg' ? 'jpg' : target_format

      if (op === 'resize') {
        if (!width && !height) return fail(new Error('resize needs width or height.'))
        const outBytes = await image.resize(bytes, { width, height }, target_format, quality)
        const target = suffixedPath(file, 'resized', extOut, out)
        writeFileSync(target, outBytes)
        const after = await image.probe(outBytes)
        return ok(`${target}\n${after.width}×${after.height}px · ${formatBytes(after.bytes)}`, {
          path: target,
          width: after.width,
          height: after.height,
          bytes: after.bytes,
          format: target_format,
        })
      }

      if (op === 'compress' && heic) {
        // No HEIC encoder exists here, so compressing a HEIC means re-encoding it as JPEG (or format).
        const outBytes = await image.convert(bytes, target_format, quality ?? 75)
        const target = suffixedPath(file, 'compressed', extOut, out)
        writeFileSync(target, outBytes)
        const after = await image.probe(outBytes)
        return ok(
          `${target}\nHEIC ${formatBytes(original.length)} → ${target_format.toUpperCase()} ${formatBytes(outBytes.length)} · ${after.width}×${after.height}px · HEIC cannot be written back, so this is a ${target_format.toUpperCase()} that opens everywhere`,
          { path: target, before: original.length, after: outBytes.length, width: after.width, height: after.height, from: 'heic', to: target_format },
        )
      }

      if (op === 'compress') {
        const result = await image.compress(bytes, target_format, quality ?? 75)
        const target = suffixedPath(file, 'compressed', extOut, out)
        writeFileSync(target, result.bytes)
        const after = await image.probe(result.bytes)
        const pct = Math.round((1 - result.bytes.length / bytes.length) * 100)
        return ok(
          `${target}\n${formatBytes(bytes.length)} → ${formatBytes(result.bytes.length)}${result.usedOriginal ? ' (re-encoding would have grown the file, copied unchanged)' : ` (${pct}% smaller)`} · ${after.width}×${after.height}px`,
          { path: target, before: bytes.length, after: result.bytes.length, width: after.width, height: after.height, usedOriginal: result.usedOriginal },
        )
      }

      // convert
      if (!format) return fail(new Error('convert needs format: jpeg, png or webp.'))
      const outBytes = await image.convert(bytes, format, quality)
      const target = outputPath(file, extOut, out)
      writeFileSync(target, outBytes)
      const after = await image.probe(outBytes)
      return ok(`${target}\n${heic ? 'heic' : (source ?? 'image')} → ${format} · ${after.width}×${after.height}px · ${formatBytes(after.bytes)}`, {
        path: target,
        from: heic ? 'heic' : source,
        to: format,
        width: after.width,
        height: after.height,
        bytes: after.bytes,
      })
    } catch (err) {
      return fail(err)
    }
  },
)

/* ------------------------------------------------------------------ qr_make */

registerDocTools(server as never)
registerProfiles(server as never)
registerCommandResources(server)

server.registerTool(
  'qr_make',
  {
    title: 'Make QR code',
    description: 'Generate a QR code as PNG or SVG from a link or text. Nothing leaves the machine.',
    inputSchema: {
      text: z.string().describe('Link or text to encode'),
      out: z.string().describe('Absolute output path ending in .png or .svg'),
      level: z.enum(['L', 'M', 'Q', 'H']).optional().describe('Error correction. Default M'),
      size: z.number().int().positive().optional().describe('PNG side length in pixels, quiet zone included. The result is exactly this wide unless it is smaller than the code itself. Default 512'),
      margin: z.number().int().min(0).optional().describe('Quiet zone in modules. Default 4'),
      dark: z.string().optional().describe('Module color. Default #000000'),
      light: z.string().optional().describe('Background color. Default #ffffff'),
    },
  },
  async ({ text, out, level, size, margin, dark, light }) => {
    try {
      const target = absolutePath(out, 'out')
      const format = ext(target) === 'svg' ? 'svg' : ext(target) === 'png' ? 'png' : null
      if (!format) return fail(new Error('out must end in .png or .svg'))
      const result = await makeQr({ text, level, size, margin, dark, light }, format)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, result.bytes)
      return ok(`${target}\n${result.modules}×${result.modules} modules · ${format === 'png' ? `${result.size}px` : 'vector'} · level ${level ?? 'M'}`, {
        path: target,
        format,
        modules: result.modules,
        size: result.size,
        bytes: result.bytes.length,
      })
    } catch (err) {
      return fail(err)
    }
  },
)

// Compiling the qpdf wasm takes a moment and every protect, unlock and
// compress waits on it. Start it now so the first of those does not.
if (process.argv[2] === '--wasi-run') {
  // This script started again as a design-engine child (src/designEngine.ts).
  await runWasiCommand(process.argv.slice(3))
} else {
  warmQpdf()
  await server.connect(new StdioServerTransport())
}
