#!/usr/bin/env node
/**
 * ezpzfile MCP server.
 *
 * The point is that an agent stops writing throwaway conversion code every
 * time it needs to touch a file. Everything runs on this machine and no file
 * is ever sent anywhere, so confidential documents are fine.
 *
 * Seven tools, not twenty six. Tool definitions sit in the model's context
 * for every session. A long list would eat the tokens this server exists to
 * save, so related jobs share one tool and are told apart by `op` or `to`.
 * When a capability is added, add a value, not a tool.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { PDFDocument, degrees } from 'pdf-lib'
import { z } from 'zod'
import { convertContainer, hwpToPdf, readDocument } from './convert'
import { ArchiveError, extractArchive } from './archive'
import { readDocx, readEml, readPdfText, readTable, tableTo } from './docs'
import * as image from './image'
import { compressPdf, imagesToPdf, looksEncrypted, protectPdf, renderPages, unlockPdf } from './pdfx'
import { makeQr } from './qr'
import { fail, formatBytes, ok, outputPath, suffixedPath } from './result'

const server = new McpServer({ name: 'ezpzfile', version: '0.2.0' })

const read = (p: string) => new Uint8Array(readFileSync(resolve(p)))
const ext = (p: string) => extname(p).toLowerCase().replace(/^\./, '')
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'bmp'])
const TABLE_EXT = new Set(['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv', 'txt', 'psv'])

/* ------------------------------------------------------------------ doc_read */

server.registerTool(
  'doc_read',
  {
    title: 'Read document',
    description:
      'Extract the text of a document: HWP, HWPX (Korean word processor, no Hancom Office needed), DOCX, PDF, or EML email. Use when the model needs to read what a file says.',
    inputSchema: {
      path: z.string().describe('Absolute path to the .hwp, .hwpx, .docx, .pdf or .eml file'),
      format: z
        .enum(['text', 'markdown'])
        .optional()
        .describe('markdown keeps headings, lists and tables where the format has them (DOCX). Default text'),
      password: z.string().optional().describe('Only for encrypted HWP, HWPX or PDF'),
    },
  },
  async ({ path, format, password }) => {
    try {
      const file = resolve(path)
      const bytes = read(file)
      const kind = ext(file)

      if (kind === 'hwp' || kind === 'hwpx') {
        const result = await readDocument(bytes, password)
        return {
          content: [{ type: 'text' as const, text: result.text }],
          structuredContent: {
            format: kind,
            pages: result.pages,
            characters: result.text.length,
            fontsUsed: result.fontsUsed,
          },
        }
      }
      if (kind === 'docx') {
        const text = await readDocx(bytes, format ?? 'text')
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
      return fail(new Error(`Unsupported file type .${kind}. doc_read handles hwp, hwpx, docx, pdf and eml.`))
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
      'Convert between file formats. HWP/HWPX to pdf, hwp or hwpx. PDF pages to jpg or png. Images to pdf (several paths become one PDF). XLSX/CSV to csv or json. Every output is reopened and checked, and the result reports what could not be carried over.',
    inputSchema: {
      path: z.string().describe('Absolute path of the source file'),
      to: z.enum(['pdf', 'hwp', 'hwpx', 'jpg', 'png', 'csv', 'json']).describe('Target format'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Additional inputs. Only for images to pdf: all images are bundled in order, path first'),
      out: z
        .string()
        .optional()
        .describe('Output path. For PDF to images this is a directory. Default: next to the source'),
      pages: z.array(z.number().int().positive()).optional().describe('PDF to images: which pages, 1-based. Default all'),
      dpi: z.number().int().positive().optional().describe('PDF to images: resolution. Default 144'),
      sheet: z.union([z.string(), z.number().int().nonnegative()]).optional().describe('Table export: sheet name or 0-based index. Default first'),
      pageSize: z.enum(['fit', 'a4']).optional().describe('Images to pdf: fit makes each page the image size, a4 centers on A4. Default fit'),
      password: z.string().optional(),
    },
  },
  async ({ path, to, paths, out, pages, dpi, sheet, pageSize, password }) => {
    try {
      const file = resolve(path)
      const kind = ext(file)
      const bytes = read(file)

      // HWP and HWPX: the original engine path, verified by reopening.
      if (kind === 'hwp' || kind === 'hwpx') {
        if (to === 'pdf') {
          const target = outputPath(file, 'pdf', out)
          const { pdf, stats } = await hwpToPdf(bytes, password)
          writeFileSync(target, pdf)
          const notes = [
            `${stats.pages} pages`,
            stats.missingGlyphs ? `${stats.missingGlyphs} characters missing from the bundled fonts` : null,
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
        return fail(new Error(`HWP/HWPX can be converted to pdf, hwp or hwpx, not ${to}.`))
      }

      // PDF pages to images.
      if (kind === 'pdf' && (to === 'jpg' || to === 'png')) {
        const dir = out ? resolve(out) : join(dirname(file), basename(file, extname(file)))
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
        const inputs = [file, ...(paths ?? []).map((p) => resolve(p))]
        const target = outputPath(file, 'pdf', out)
        const { pdf, pages: count } = await imagesToPdf(inputs.map(read), { pageSize: pageSize ?? 'fit', margin: 36 })
        writeFileSync(target, pdf)
        const check = await PDFDocument.load(pdf)
        return ok(`${target}\n${count} pages from ${inputs.length} images · reopened, ${check.getPageCount()} pages`, {
          path: target,
          pages: count,
          inputs: inputs.length,
          pageMatch: check.getPageCount() === inputs.length,
        })
      }

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
      'Edit PDF files: merge, extract, delete, rotate, reorder, split, compress (lossless), protect (set password), unlock (remove password). Page numbers are 1-based.',
    inputSchema: {
      op: z.enum(['merge', 'extract', 'delete', 'rotate', 'reorder', 'split', 'compress', 'protect', 'unlock']),
      paths: z.array(z.string()).describe('merge takes several files, every other op takes one'),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe('extract, delete, rotate: pages to act on. Default all'),
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
      out: z.string().optional().describe('Output path. split: output directory'),
    },
  },
  async ({ op, paths, pages, degrees: angle, order, at, password, ownerPassword, allowPrint, allowCopy, out }) => {
    try {
      const inputs = paths.map((p) => resolve(p))
      const first = inputs[0]
      if (!first) return fail(new Error('paths must contain at least one file.'))
      const target = suffixedPath(first, op, 'pdf', out)

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
      const picked = (pages ?? Array.from({ length: total }, (_, i) => i + 1))
        .filter((n) => n >= 1 && n <= total)
        .map((n) => n - 1)

      if (op === 'extract' || op === 'reorder') {
        const indices =
          op === 'reorder'
            ? (order ?? []).filter((n) => n >= 1 && n <= total).map((n) => n - 1)
            : picked
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
      const cuts = [...new Set((at ?? []).filter((n) => n > 1 && n <= total))].sort((a, b) => a - b)
      if (cuts.length === 0) return fail(new Error('split needs at: page numbers where a new file starts, e.g. [4,8].'))
      const dir = out ? resolve(out) : dirname(first)
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
    inputSchema: { path: z.string() },
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
      'Resize, compress, convert (jpeg, png, webp) or strip metadata (EXIF, GPS, XMP) from an image. strip_metadata never re-encodes pixels. Returns the real output dimensions and byte size.',
    inputSchema: {
      path: z.string().describe('Absolute path of the source image'),
      op: z.enum(['resize', 'compress', 'convert', 'strip_metadata']),
      width: z.number().int().positive().optional().describe('resize: give width or height alone to keep the aspect ratio'),
      height: z.number().int().positive().optional(),
      quality: z.number().min(1).max(100).optional().describe('compress, convert, resize: 1-100. Default 85 (compress 75)'),
      format: z.enum(['jpeg', 'png', 'webp']).optional().describe('convert: target format. Others: default keeps the source format'),
      out: z.string().optional(),
    },
  },
  async ({ path, op, width, height, quality, format, out }) => {
    try {
      const file = resolve(path)
      const bytes = read(file)

      if (op === 'strip_metadata') {
        const result = await image.strip(bytes, basename(file))
        const target = suffixedPath(file, 'clean', ext(file) || result.format, out)
        writeFileSync(target, result.bytes)
        const what = result.tags.length ? result.tags.join(', ') : 'nothing found'
        return ok(`${target}\nremoved: ${what} · ${formatBytes(result.removed)} smaller · pixels untouched`, {
          path: target,
          format: result.format,
          removed: result.tags,
          removedBytes: result.removed,
          before: bytes.length,
          after: result.bytes.length,
        })
      }

      const source = await image.detectFormat(bytes)
      const target_format = format ?? source
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
      return ok(`${target}\n${source ?? 'image'} → ${format} · ${after.width}×${after.height}px · ${formatBytes(after.bytes)}`, {
        path: target,
        from: source,
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

server.registerTool(
  'qr_make',
  {
    title: 'Make QR code',
    description: 'Generate a QR code as PNG or SVG from a link or text. Nothing leaves the machine.',
    inputSchema: {
      text: z.string().describe('Link or text to encode'),
      out: z.string().describe('Output path ending in .png or .svg'),
      level: z.enum(['L', 'M', 'Q', 'H']).optional().describe('Error correction. Default M'),
      size: z.number().int().positive().optional().describe('PNG side length in pixels. Default 512'),
      margin: z.number().int().min(0).optional().describe('Quiet zone in modules. Default 4'),
      dark: z.string().optional().describe('Module color. Default #000000'),
      light: z.string().optional().describe('Background color. Default #ffffff'),
    },
  },
  async ({ text, out, level, size, margin, dark, light }) => {
    try {
      const target = resolve(out)
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

/* ------------------------------------------------------------------ archive_extract */

server.registerTool(
  'archive_extract',
  {
    title: 'Extract archive',
    description:
      'Extract a ZIP archive. Restores Korean, Japanese and Chinese file names that Windows stored in a local code page. Entries that try to escape the target folder are rejected.',
    inputSchema: {
      path: z.string().describe('Absolute path of the .zip file'),
      out: z.string().optional().describe('Folder to extract into. Default: a folder named after the archive, next to it'),
      files: z.array(z.string()).optional().describe('Only these entries (paths inside the archive)'),
      lang: z
        .enum(['ko', 'ja', 'zh', 'zh-tw', 'th', 'ru', 'en'])
        .optional()
        .describe('Language the archive was made in, used to repair non-UTF-8 file names. Default ko'),
    },
  },
  async ({ path, out, files, lang }) => {
    try {
      const file = resolve(path)
      if (!existsSync(file) || !statSync(file).isFile()) return fail(new Error(`File not found: ${file}`))
      const result = extractArchive(file, read(file), { out, files, localeHint: lang })
      const total = result.files.reduce((n, f) => n + f.bytes, 0)
      const names = result.files.slice(0, 20).map((f) => f.path.slice(result.dir.length + 1))
      const more = result.files.length > 20 ? ` … and ${result.files.length - 20} more` : ''
      const rejected = result.rejected.length ? `\nrejected ${result.rejected.length} unsafe entries: ${result.rejected.join(', ')}` : ''
      return ok(`${result.dir}\n${result.files.length} files · ${formatBytes(total)}\n${names.join('\n')}${more}${rejected}`, {
        dir: result.dir,
        count: result.files.length,
        bytes: total,
        files: result.files,
        rejected: result.rejected,
      })
    } catch (err) {
      if (err instanceof ArchiveError) return fail(err)
      return fail(err)
    }
  },
)

await server.connect(new StdioServerTransport())
