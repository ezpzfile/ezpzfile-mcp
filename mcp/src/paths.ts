/**
 * Path handling for tool arguments.
 *
 * The server is started by the MCP client, so its working directory is the
 * client's, not the folder the user is working in. `resolve('notes.pdf')`
 * therefore lands somewhere neither of them meant: usually a missing file, and
 * occasionally the wrong real one. Relative paths used to be accepted, which
 * made that failure silent. They are refused now.
 */
import { isAbsolute, normalize } from 'node:path'

export function absolutePath(value: string, label = 'path'): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is empty.`)
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `${label} must be absolute, received "${value}". This server runs with the working directory of whatever started it, not yours, so a relative path would point somewhere unexpected. Pass the full path, for example /Users/you/Documents/report.pdf or C:\\Users\\you\\Documents\\report.pdf.`,
    )
  }
  return normalize(trimmed)
}
