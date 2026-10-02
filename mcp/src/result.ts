/**
 * Shared result helpers for every tool.
 *
 * Each tool returns one human readable line plus structuredContent, so a model
 * can read the summary and a script can read the fields. Keeping this in one
 * place is what keeps the six tools looking like one product.
 */
import { basename, dirname, extname, join } from 'node:path'
import { HwpDocError } from './engine'
import { sniffHwp, type HwpBadKind } from '../../src/lib/hwpSniff'
import { absolutePath } from './paths'

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: true
}

/** Where to put the output. Without `out`, write next to the input with a new extension. */
export function outputPath(input: string, ext: string, requested?: string): string {
  if (requested) return absolutePath(requested, 'out')
  const dir = dirname(input)
  const stem = basename(input, extname(input))
  return join(dir, `${stem}.${ext}`)
}

/** Same as outputPath but adds a suffix so an edit never overwrites its source. */
export function suffixedPath(input: string, suffix: string, ext: string, requested?: string): string {
  if (requested) return absolutePath(requested, 'out')
  const dir = dirname(input)
  const stem = basename(input, extname(input))
  return join(dir, `${stem}-${suffix}.${ext}`)
}

/**
 * What an "HWP" the engine could not open really is. The engine reads real Hangul
 * documents back to HWP 3.0, so a failure is usually a file that is not one: DRM,
 * an Office file or PDF with an .hwp name, a broken download. Same cases as the site
 * (src/lib/hwpSniff.ts), worded for an agent that can act on them.
 */
function unreadable(kind: HwpBadKind | undefined): string {
  switch (kind) {
    case 'foreign':
      return 'This does not look like an HWP document. Files locked by a company or government document security system (DRM) are encrypted like this and only open in Hangul on a computer with that security software. Ask for a copy with the protection removed, or a PDF.'
    case 'office':
      return 'Only the name says HWP: this is a Word, Excel or PowerPoint file. Give it the right extension (.docx, .xlsx, .pptx) and read it with doc_read.'
    case 'pdf':
      return 'Only the name says HWP: this is a PDF. Give it a .pdf extension and use doc_read or pdf_info.'
    case 'web':
      return 'This is a web page or plain text, not an HWP document. The download probably did not finish properly. Download it again from the original site.'
    case 'archive':
      return 'This is a zip archive, but not an HWPX document. Unzip it and use the .hwp or .hwpx file inside.'
    case 'empty':
      return 'The file is empty. The download may have been cut off.'
    default:
      return 'The HWP document could not be read to the end. The file is probably damaged or the download was cut off. If it opens in Hangul, save it under a new name and try again.'
  }
}

/**
 * What a file with the wrong name really is, from its first bytes, for formats
 * other than HWP (Ichitaro, DocuWorks). Null when the bytes say nothing useful.
 */
export function whatItReallyIs(bytes: Uint8Array): string | null {
  switch (sniffHwp(bytes).kind) {
    case 'pdf':
      return 'It is a PDF: give it a .pdf extension and use doc_read or pdf_info.'
    case 'office':
      return 'It is a Word, Excel or PowerPoint file with the wrong extension.'
    case 'web':
      return 'It is a web page or plain text, which usually means the download did not finish properly.'
    case 'archive':
      return 'It is a zip archive. Unzip it and use the file inside.'
    case 'empty':
      return 'The file is empty. The download may have been cut off.'
    default:
      return null
  }
}

export function fail(err: unknown): ToolResult {
  const message =
    err instanceof HwpDocError
      ? {
          PASSWORD_REQUIRED:
            'This document is password protected. Call again with the password argument.',
          PASSWORD_WRONG: 'Wrong password.',
          UNREADABLE: unreadable(err.kind),
          EMPTY: 'The document has no pages.',
        }[err.code]
      : String((err as Error)?.message ?? err)
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function ok(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: data,
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
