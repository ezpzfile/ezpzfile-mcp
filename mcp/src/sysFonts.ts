/**
 * Fonts installed on this machine, found by name.
 *
 * A PDF usually embeds only the characters it uses. When a filled-in template needs a
 * character the embedded subset lacks, the text has to be drawn with a whole font. The
 * best one is the same font the document used, and the machine that made the design
 * often has it: "BAAAAA+NotoSansCJKkr-Bold" → NotoSansCJKkr-Bold. Only when no font
 * of that name (or family and weight) is here does the bundled Korean font step in.
 *
 * The index is built once per process, on first need, from the usual font folders.
 * A font inside a collection (.ttc) is cut out into a standalone font, because the PDF
 * writer embeds single fonts only.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as fontkit from 'fontkit'
import pdfFontkit from '@pdf-lib/fontkit'

export interface SysFont {
  path: string
  /** index inside a .ttc, 0 otherwise */
  index: number
  postscript: string
  family: string
  style: string
  bold: boolean
  italic: boolean
}

const norm = (s: string) => s.toLowerCase().replace(/[\s\-_,.]+/g, '')

function folders(): string[] {
  const home = homedir()
  const extra = (process.env.EZPZFILE_FONT_DIRS ?? '').split(/[;:](?![\\/])/).filter(Boolean)
  return [
    ...extra,
    '/System/Library/Fonts',
    '/Library/Fonts',
    join(home, 'Library/Fonts'),
    'C:\\Windows\\Fonts',
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Microsoft/Windows/Fonts'),
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    join(home, '.fonts'),
    join(home, '.local/share/fonts'),
  ]
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 5 || out.length > 5000) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out, depth + 1)
    else if (/\.(ttf|otf|ttc|otc)$/i.test(n) && st.size < 60 << 20) out.push(p)
  }
}

let index: SysFont[] | null = null

export function systemFontIndex(): SysFont[] {
  if (index) return index
  const files: string[] = []
  for (const d of folders()) if (existsSync(d)) walk(d, files)
  index = []
  for (const path of files) {
    try {
      const f = fontkit.openSync(path) as unknown as { fonts?: FontLike[] } & FontLike
      const list = f.fonts ?? [f]
      list.forEach((one, i) => {
        const style = one.subfamilyName ?? ''
        index!.push({
          path,
          index: f.fonts ? i : 0,
          postscript: one.postscriptName ?? '',
          family: one.familyName ?? '',
          style,
          bold: /bold|black|heavy|semibold|demibold/i.test(`${style} ${one.postscriptName}`),
          italic: /italic|oblique/i.test(`${style} ${one.postscriptName}`),
        })
      })
    } catch {
      // unreadable font file: skip
    }
  }
  return index
}

interface FontLike {
  postscriptName?: string
  familyName?: string
  subfamilyName?: string
}

/** The installed font a PDF font name stands for, or null. */
export function findSystemFont(pdfName: string): SysFont | null {
  const bare = pdfName.replace(/^[A-Z]{6}\+/, '')
  if (!bare) return null
  const want = norm(bare)
  const all = systemFontIndex()
  const exact = all.find((f) => norm(f.postscript) === want)
  if (exact) return exact
  // "Family-Style" or "Family,Bold"
  const [famPart, stylePart = ''] = bare.split(/[-,]/)
  const fam = norm(famPart ?? '')
  const bold = /bold|black|heavy/i.test(stylePart)
  const italic = /italic|oblique/i.test(stylePart)
  const sameFamily = all.filter((f) => norm(f.family) === fam || norm(f.postscript).startsWith(fam))
  return sameFamily.find((f) => f.bold === bold && f.italic === italic) ?? sameFamily.find((f) => f.bold === bold) ?? null
}

/** Bytes of one font, cut out of its collection when it lives in a .ttc. */
export function fontBytes(f: SysFont): Uint8Array {
  const data = new Uint8Array(readFileSync(f.path))
  const tag = String.fromCharCode(...data.subarray(0, 4))
  if (tag !== 'ttcf') return data
  return cutFromCollection(data, f.index)
}

/** A standalone sfnt from font `n` of a TrueType/OpenType collection. */
function cutFromCollection(data: Uint8Array, n: number): Uint8Array {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = dv.getUint32(8)
  if (n >= count) throw new Error('font index outside the collection')
  const at = dv.getUint32(12 + 4 * n)
  const numTables = dv.getUint16(at + 4)
  const tables: { tag: number; checksum: number; offset: number; length: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const r = at + 12 + 16 * i
    tables.push({ tag: dv.getUint32(r), checksum: dv.getUint32(r + 4), offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) })
  }
  const head = 12 + 16 * numTables
  let size = head
  for (const t of tables) size += (t.length + 3) & ~3
  const out = new Uint8Array(size)
  const ov = new DataView(out.buffer)
  out.set(data.subarray(at, at + 12), 0)
  let pos = head
  tables.forEach((t, i) => {
    const r = 12 + 16 * i
    ov.setUint32(r, t.tag)
    ov.setUint32(r + 4, t.checksum)
    ov.setUint32(r + 8, pos)
    ov.setUint32(r + 12, t.length)
    out.set(data.subarray(t.offset, t.offset + t.length), pos)
    pos += (t.length + 3) & ~3
  })
  return out
}

/** Does this font draw every character of `text`? */
export function covers(f: SysFont, text: string): boolean {
  try {
    // the name picks a face out of a collection; a single font refuses it
    const font = (/\.(ttc|otc)$/i.test(f.path) ? fontkit.openSync(f.path, f.postscript) : fontkit.openSync(f.path)) as unknown as { hasGlyphForCodePoint(cp: number): boolean }
    return [...text].every((ch) => /\s/.test(ch) || font.hasGlyphForCodePoint(ch.codePointAt(0)!))
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- subsetting */

type HbExports = {
  memory: WebAssembly.Memory
  malloc(n: number): number
  free(p: number): void
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number
  hb_blob_destroy(b: number): void
  hb_blob_get_length(b: number): number
  hb_blob_get_data(b: number, lenPtr: number): number
  hb_face_create(blob: number, index: number): number
  hb_face_destroy?(f: number): void
  hb_face_reference_blob(f: number): number
  hb_set_add(set: number, cp: number): void
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(i: number): void
  hb_subset_input_unicode_set(i: number): number
  hb_subset_input_set_flags(i: number, flags: number): void
  hb_subset_or_fail(face: number, input: number): number
}

let hb: HbExports | null = null

async function harfbuzz(): Promise<HbExports> {
  if (hb) return hb
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  // harfbuzzjs (MIT) ships hb-subset as a standalone wasm with no imports
  let wasmPath: string
  try {
    wasmPath = require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')
  } catch {
    const { dirname } = await import('node:path')
    wasmPath = join(dirname(require.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')
  }
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  hb = instance.exports as unknown as HbExports
  return hb
}

/** Can the PDF writer's parser read the subset and measure and outline every needed glyph? */
function readable(bytes: Uint8Array, text: string): boolean {
  try {
    const f = (pdfFontkit as unknown as { create(b: Buffer): unknown }).create(Buffer.from(bytes)) as unknown as { glyphForCodePoint(cp: number): { advanceWidth: number; cbox: unknown; path: unknown } }
    for (const ch of new Set([...text])) {
      const g = f.glyphForCodePoint(ch.codePointAt(0)!)
      void g.advanceWidth
      void g.cbox
      void g.path
    }
    return true
  } catch {
    return false
  }
}

/**
 * Keep only the glyphs `text` needs (plus what shaping reaches from them), with harfbuzz.
 * A 6.5 MB CJK font drawing four names comes down to a few kilobytes. On any failure the
 * whole font is returned: a heavier file beats a missing character.
 */
export async function subsetFont(font: Uint8Array, text: string): Promise<Uint8Array> {
  // Renumbered glyphs make the smallest file. Some TrueType fonts (Nanum Myeongjo) come
  // out of that unreadable to the PDF writer's parser; keeping glyph ids in place fixes it.
  for (const flags of [0, 2 /* HB_SUBSET_FLAGS_RETAIN_GIDS */]) {
    const out = await subsetOnce(font, text, flags).catch(() => null)
    if (out && out.byteLength > 100 && readable(out, text)) return out
  }
  return font
}

async function subsetOnce(font: Uint8Array, text: string, flags: number): Promise<Uint8Array> {
  const h = await harfbuzz()
  const ptr = h.malloc(font.byteLength)
  new Uint8Array(h.memory.buffer, ptr, font.byteLength).set(font)
  const blob = h.hb_blob_create(ptr, font.byteLength, 2 /* writable */, 0, 0)
  const face = h.hb_face_create(blob, 0)
  const input = h.hb_subset_input_create_or_fail()
  try {
    h.hb_subset_input_set_flags(input, flags)
    const set = h.hb_subset_input_unicode_set(input)
    const cps = new Set<number>([...text].map((c) => c.codePointAt(0)!))
    for (let c = 0x20; c < 0x7f; c++) cps.add(c) // ASCII, cheap and often needed
    for (const cp of cps) h.hb_set_add(set, cp)
    const sub = h.hb_subset_or_fail(face, input)
    if (!sub) throw new Error('subset failed')
    const outBlob = h.hb_face_reference_blob(sub)
    const len = h.hb_blob_get_length(outBlob)
    const data = h.hb_blob_get_data(outBlob, 0)
    const out = new Uint8Array(h.memory.buffer, data, len).slice()
    h.hb_blob_destroy(outBlob)
    h.hb_face_destroy?.(sub)
    return out
  } finally {
    h.hb_subset_input_destroy(input)
    h.hb_face_destroy?.(face)
    h.hb_blob_destroy(blob)
    h.free(ptr)
  }
}
