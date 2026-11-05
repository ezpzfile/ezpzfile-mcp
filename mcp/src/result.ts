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

/**
 * Every failure has the same shape, so an agent can branch on `code` and see in `needs`
 * what to supply before calling again, instead of parsing English.
 *
 *   { code: 'PASSWORD_REQUIRED', message: '…', needs: ['password'] }
 */
export type ErrorCode =
  | 'NOT_FOUND' // no such file
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_WRONG'
  | 'UNREADABLE' // damaged, or not the format its name says
  | 'TOO_LARGE' // a limit was hit: too large or damaged
  | 'EMPTY'
  | 'UNSUPPORTED' // this format or op is not handled
  | 'BAD_ARGUMENT' // an argument is missing, out of range or inconsistent
  | 'RULE' // an edit would break a rule of the format (see ezpzfile://formats/<fmt>)
  | 'NOT_APPLIED' // nothing matched: the edit changed nothing
  | 'VERIFY_FAILED' // written, but reopening did not confirm it
  | 'ENGINE' // a document engine stopped; the next call gets a fresh one

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly needs: string[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** Old errors are plain Errors with English text. Sort them into codes by what they say. */
function classify(message: string): { code: ErrorCode; needs: string[] } {
  if (/ENOENT|no such file/i.test(message)) return { code: 'NOT_FOUND', needs: ['an absolute path to an existing file'] }
  if (/too large or damaged|max(Expand|Bytes|Pages|Ratio|ImagePixels|Records|Points)\b/i.test(message)) return { code: 'TOO_LARGE', needs: [] }
  if (/password protected|needs? (a|the) password|encrypted.*password/i.test(message)) return { code: 'PASSWORD_REQUIRED', needs: ['password'] }
  if (/wrong password|incorrect password/i.test(message)) return { code: 'PASSWORD_WRONG', needs: ['the correct password'] }
  if (/unsupported|can be converted to|not supported|cannot be converted|handles? only|is not handled/i.test(message)) return { code: 'UNSUPPORTED', needs: [] }
  if (/does not exist\. This PDF has|must be|is required|needs? `|out of range|invalid/i.test(message)) return { code: 'BAD_ARGUMENT', needs: [] }
  if (/not an? (Ichitaro|DocuWorks|HWP)|could not be read|damaged|not look like/i.test(message)) return { code: 'UNREADABLE', needs: [] }
  if (/unreachable|RuntimeError|memory access out of bounds/i.test(message)) return { code: 'ENGINE', needs: [] }
  return { code: 'UNREADABLE', needs: [] }
}

export function fail(err: unknown): ToolResult {
  let code: ErrorCode
  let message: string
  let needs: string[] = []
  let details: Record<string, unknown> | undefined
  if (err instanceof ToolError) {
    ;({ code, message, needs } = err)
    details = err.details
  } else if (err instanceof HwpDocError) {
    code = err.code === 'PASSWORD_REQUIRED' ? 'PASSWORD_REQUIRED' : err.code === 'PASSWORD_WRONG' ? 'PASSWORD_WRONG' : err.code === 'EMPTY' ? 'EMPTY' : 'UNREADABLE'
    message = {
      PASSWORD_REQUIRED: 'This document is password protected. Call again with the password argument.',
      PASSWORD_WRONG: 'Wrong password.',
      UNREADABLE: unreadable(err.kind),
      EMPTY: 'The document has no pages.',
    }[err.code]
    if (code === 'PASSWORD_REQUIRED') needs = ['password']
    if (code === 'PASSWORD_WRONG') needs = ['the correct password']
  } else {
    message = String((err as Error)?.message ?? err)
    ;({ code, needs } = classify(message))
  }
  const error = { code, message, needs, ...(details ? { details } : {}) }
  return {
    content: [{ type: 'text', text: `${code}: ${message}${needs.length ? ` (needs: ${needs.join(', ')})` : ''}` }],
    structuredContent: { error },
    isError: true,
  }
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
