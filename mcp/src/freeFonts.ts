/**
 * A free font fetched by name, for a document whose font this machine does not have.
 *
 * The font finder's lists (ff.ezpzfile.com) know every free family it compares against,
 * and for Google Fonts families the address of each weight's TTF. When a template was
 * built on, say, "BAAAAA+NanumMyeongjo-Bold" and no font of that name is installed, the
 * same family is downloaded once into the cache and used like an installed one. Only
 * families under the SIL Open Font License are taken, so embedding is always allowed.
 *
 * Only the font's name goes out (as the file asked for); nothing of the document does.
 * EZPZFILE_NO_FONT_DOWNLOAD=1 turns it off.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as fontkit from 'fontkit'
import { loadList, type FontFamily, type FontScript } from '../../src/lib/fontfind/data'
import { cacheDir } from './matte'
import type { SysFont } from './sysFonts'

const norm = (s: string) => s.toLowerCase().replace(/[\s\-_,.]+/g, '')
const SCRIPTS: FontScript[] = ['ko', 'la', 'ja', 'zh', 'cy', 'gr', 'ar', 'th', 'hi', 'vi']
const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extralight|ultralight/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semibold|demibold/i, 600],
  [/extrabold|ultrabold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
]

let families: Promise<FontFamily[]> | null = null
function allFamilies(): Promise<FontFamily[]> {
  families ??= Promise.all(SCRIPTS.map((s) => loadList(s).catch(() => [] as FontFamily[]))).then((l) => l.flat().filter((f) => f.src === 'g' && f.dl))
  return families
}

/** The family a PDF font name stands for, and the weight asked for. */
export async function freeFamilyFor(pdfName: string): Promise<{ fam: FontFamily; weight: number; url: string } | null> {
  const bare = pdfName.replace(/^[A-Z]{6}\+/, '')
  if (!bare) return null
  const [famPart = '', stylePart = ''] = bare.split(/[-,]/)
  const want = norm(famPart)
  if (want.length < 3) return null
  const list = await allFamilies()
  const fam = list.find((f) => norm(f.name) === want || norm(f.k) === want) ?? list.find((f) => (f.ko && norm(f.ko) === want) || (f.ja && norm(f.ja) === want))
  if (!fam?.dl) return null
  let weight = 400
  for (const [re, w] of WEIGHTS) if (re.test(stylePart)) { weight = w; break }
  const have = Object.keys(fam.dl).map(Number).filter((n) => !Number.isNaN(n))
  if (!have.length) return null
  const near = have.sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)[0]!
  return { fam, weight: near, url: fam.dl[String(near)]! }
}

/** Download (once) the free font a PDF font name stands for; null when there is none. */
export async function freeFont(pdfName: string): Promise<SysFont | null> {
  if (process.env.EZPZFILE_NO_FONT_DOWNLOAD === '1') return null
  let hit
  try {
    hit = await freeFamilyFor(pdfName)
  } catch {
    return null
  }
  if (!hit) return null
  const dir = join(cacheDir(), 'fonts')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${hit.fam.s}-${hit.weight}.ttf`)
  if (!existsSync(file)) {
    try {
      const r = await fetch(hit.url)
      if (!r.ok) return null
      const bytes = new Uint8Array(await r.arrayBuffer())
      if (bytes.length < 1000) return null
      const part = `${file}.${process.pid.toString(36)}.part`
      writeFileSync(part, bytes)
      renameSync(part, file)
    } catch {
      return null
    }
  }
  try {
    const f = fontkit.create(readFileSync(file)) as unknown as { postscriptName?: string; familyName?: string; subfamilyName?: string }
    return { path: file, index: 0, postscript: f.postscriptName ?? `${hit.fam.s}-${hit.weight}`, family: f.familyName ?? hit.fam.name, style: f.subfamilyName ?? '', bold: hit.weight >= 600, italic: false }
  } catch {
    return null
  }
}
