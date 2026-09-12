/**
 * Shared result helpers for every tool.
 *
 * Each tool returns one human readable line plus structuredContent, so a model
 * can read the summary and a script can read the fields. Keeping this in one
 * place is what keeps the six tools looking like one product.
 */
import { basename, dirname, extname, join } from 'node:path'
import { HwpDocError } from './engine'
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

export function fail(err: unknown): ToolResult {
  const message =
    err instanceof HwpDocError
      ? {
          PASSWORD_REQUIRED:
            'This document is password protected. Call again with the password argument.',
          PASSWORD_WRONG: 'Wrong password.',
          UNREADABLE:
            'Could not read the document. It may be a very old format (HWP 3.0) or a damaged file.',
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
