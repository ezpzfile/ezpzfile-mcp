/**
 * Archive extraction.
 *
 * ZIP goes through fflate, the same library the site uses. The file name fix
 * (src/lib/encoding.ts) matters more than it looks: Windows ZIPs made in
 * Korea, Japan or China store names in the local code page, not UTF-8, and
 * without the fix every name comes out as mojibake.
 *
 * Archives are untrusted input. An entry named "../../.ssh/authorized_keys"
 * must never land outside the target folder, so every name is checked before
 * anything is written.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { fixArchiveName } from '../../src/lib/encoding'

export interface ExtractedFile {
  path: string
  bytes: number
}

export interface ExtractResult {
  dir: string
  files: ExtractedFile[]
  /** Entries that were skipped because their name tried to escape the folder */
  rejected: string[]
}

export class ArchiveError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'corrupt' | 'empty',
    message: string,
  ) {
    super(message)
  }
}

const SUPPORTED = new Set(['.zip'])
const KNOWN_BUT_NOT_YET = new Set(['.7z', '.rar', '.tar', '.gz', '.tgz'])

export function defaultExtractDir(archive: string): string {
  return join(dirname(archive), basename(archive, extname(archive)))
}

/** True when the entry name stays inside the target directory after normalization. */
function safeRelative(name: string): string | null {
  if (!name || isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return null
  const cleaned = normalize(name.replace(/\\/g, '/'))
  const parts = cleaned.split(sep)
  if (parts.some((p) => p === '..')) return null
  return cleaned
}

export function extractArchive(
  archivePath: string,
  data: Uint8Array,
  opts: { out?: string; files?: string[]; localeHint?: string } = {},
): ExtractResult {
  const ext = extname(archivePath).toLowerCase()
  if (!SUPPORTED.has(ext)) {
    if (KNOWN_BUT_NOT_YET.has(ext)) {
      throw new ArchiveError(
        'unsupported',
        `${ext} archives are not supported yet. Only .zip can be extracted in this version.`,
      )
    }
    throw new ArchiveError('unsupported', `Unrecognized archive type: ${ext || '(no extension)'}`)
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(data)
  } catch (err) {
    throw new ArchiveError('corrupt', `Could not read the ZIP: ${String((err as Error).message ?? err)}`)
  }

  const dir = resolve(opts.out ?? defaultExtractDir(archivePath))
  const wanted = opts.files ? new Set(opts.files.map((f) => f.replace(/\\/g, '/'))) : null
  const files: ExtractedFile[] = []
  const rejected: string[] = []

  for (const [rawName, bytes] of Object.entries(entries)) {
    if (rawName.endsWith('/')) continue
    const name = fixArchiveName(rawName, opts.localeHint ?? 'ko')
    if (wanted && !wanted.has(name) && !wanted.has(rawName)) continue
    const rel = safeRelative(name)
    if (!rel) {
      rejected.push(name)
      continue
    }
    const target = join(dir, rel)
    // Belt and braces: even after normalization the resolved path must stay under dir.
    if (!target.startsWith(dir + sep) && target !== dir) {
      rejected.push(name)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    files.push({ path: target, bytes: bytes.length })
  }

  if (files.length === 0 && rejected.length === 0) {
    throw new ArchiveError('empty', wanted ? 'None of the requested files were found in the archive.' : 'The archive has no files.')
  }
  return { dir, files, rejected }
}
