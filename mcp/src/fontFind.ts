/**
 * Which font is this? The ezpzfile.com font finder (/fonts), for agents: a picture in,
 * the closest families out, free and paid, with their licences and where to get them.
 *
 * Same data and models as the site (lib/fontfind: glyph fingerprints, the line model,
 * the OCR models, all fetched once from ff.ezpzfile.com). The steps are the ones the
 * site's FontFinder runs (components/fontfind/FontFinder.tsx: readLines, assignScripts,
 * defaultLines, buildSheet, readView, find), ported without the screen. Keep the two in
 * step when the scoring changes there.
 *
 * Steps: find and read the text lines (OCR) → pick the biggest lines of one script →
 * straighten them onto one sheet → cut glyphs, read them against the fingerprints →
 * score every family two ways (the line model's look, glyph matching) and mix them.
 */
import { extract, fillHoles, findLines, innerBody, isHollowLine, rankFaces, readGlyph, toInk } from '../../src/lib/fontfind/core'
import type { Box, Glyph, Gray, Observed, Ref16 } from '../../src/lib/fontfind/core'
import { fontRef, loadList, loadMeta, loadOcr, loadOcrKo, loadOcrLang, loadPaidList, loadRef, modelRank, officialUrl, previewUrl, pvFor, scriptSims, tableFor, type FontFamily, type FontScript, type OcrLang } from '../../src/lib/fontfind/data'
import { fitLine, ML_ALPHA, paidScore } from '../../src/lib/fontfind/ml'
import { countKinds, cropRect, detect, lineKind, normalizeStrip, quadBox, recognize, rectQuad, rgbaGray, splitByChars, verticalToRow } from '../../src/lib/fontfind/ocr'
import type { OcrChar, OcrLine, Rgba, RRect } from '../../src/lib/fontfind/ocr'
import { rankPaidGlyph } from '../../src/lib/fontfind/paidglyph'
import type { PaidGlyphScore } from '../../src/lib/fontfind/paidglyph'
import { ortDir } from './matte'
import { ToolError } from './result'
import { getSharp } from './sharp'

const MAX_SIDE = 1800
const PAID_DELTA = 0
const OWN_OCR: FontScript[] = ['ar', 'cy', 'gr', 'th', 'hi']

interface Line extends OcrLine {
  sc: FontScript | null
  guessed?: boolean
  fallback?: FontScript
}
interface StripInfo {
  y0: number
  y1: number
  w: number
  chars: OcrChar[]
  text?: string
}
interface View {
  gray: Gray
  lines: Box[]
  lineGlyphs: Box[][]
  glyphs: Glyph[]
  read: string
  readScore: number
  chars?: string[]
}
interface Match {
  fam: FontFamily
  face: number
  score: number
  weight: number
}

let ortReady: Promise<void> | null = null
/** The models run on onnxruntime-web; its wasm comes from the same cache as background removal. */
function prepareOrt(): Promise<void> {
  ortReady ??= (async () => {
    const ort = await import('onnxruntime-web/wasm')
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmPaths = await ortDir()
  })()
  return ortReady
}

async function readImage(bytes: Uint8Array): Promise<{ gray: Gray; rgba: Rgba; w: number; h: number }> {
  const sharp = await getSharp()
  const meta = await sharp(bytes).metadata()
  const s = Math.min(1, MAX_SIDE / Math.max(meta.width ?? 1, meta.height ?? 1))
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize({ width: Math.max(1, Math.round((meta.width ?? 1) * s)) })
    .flatten({ background: '#ffffff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const id = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
  const g = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (id[j]! * 299 + id[j + 1]! * 587 + id[j + 2]! * 114) / 1000
  return { gray: { w, h, data: g }, rgba: { w, h, data: id }, w, h }
}

/* ---- the site's helpers, unchanged in substance ---- */

const stripOf = (img: Rgba, r: RRect, h: number): Rgba => (r.vertical ? verticalToRow(cropRect(img, r, h)) : cropRect(img, r, h))

async function readLines(img: Rgba, region?: Box): Promise<OcrLine[]> {
  const { det, rec, dict } = await loadOcr()
  let src = img
  let ox = 0
  let oy = 0
  if (region) {
    const w = region.x1 - region.x0
    const h = region.y1 - region.y0
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) d.set(img.data.subarray(((y + region.y0) * img.w + region.x0) * 4, ((y + region.y0) * img.w + region.x1) * 4), y * w * 4)
    src = { w, h, data: d }
    ox = region.x0
    oy = region.y0
  }
  const ds = (await detect(src, det)).sort((a, b) => b.rect.th - a.rect.th).slice(0, 16)
  const rects: { rect: RRect; score: number; r?: Awaited<ReturnType<typeof recognize>> }[] = []
  for (const d of ds) {
    const r = await recognize(stripOf(src, d.rect, 48), rec, dict)
    if (r.conf < 0.6 && !d.rect.vertical && Math.abs(d.rect.ang) < (3 * Math.PI) / 180 && d.rect.th > d.rect.len * 0.35) {
      const g = normalizeStrip(rgbaGray(cropRect(src, { ...d.rect, ang: 0 })))
      const rows = findLines(toInk(g, false)).filter((b) => b.y1 - b.y0 >= 8)
      if (rows.length >= 2) {
        for (const b of rows) {
          const hgt = b.y1 - b.y0
          rects.push({ rect: { cx: d.rect.cx - g.w / 2 + (b.x0 + b.x1) / 2, cy: d.rect.cy - g.h / 2 + (b.y0 + b.y1) / 2, len: Math.min(g.w, b.x1 - b.x0 + hgt * 0.4), th: hgt * 1.4, ang: 0, vertical: false }, score: d.score })
        }
        continue
      }
    }
    rects.push({ ...d, r })
  }
  const out: OcrLine[] = []
  for (const d of rects) {
    const r = d.r ?? (await recognize(stripOf(src, d.rect, 48), rec, dict))
    const rect = { ...d.rect, cx: d.rect.cx + ox, cy: d.rect.cy + oy }
    const quad = rectQuad(rect)
    out.push({ rect, quad, box: quadBox(quad, img.w, img.h), h: rect.th, det: d.score, ...r })
  }
  return out
}

async function lineSims(img: Rgba, r: RRect, scripts: FontScript[]) {
  const g = normalizeStrip(rgbaGray(stripOf(img, r, 64)))
  const ls = extract(toInk(g), 'la').filter((l) => l.glyphs.length)
  return scriptSims(g, ls.length ? ls.map((l) => l.box) : [{ x0: 0, y0: 0, x1: g.w, y1: g.h }], ls.length ? ls.map((l) => l.glyphs.map((gg) => gg.box)) : undefined, scripts)
}

async function assignScripts(img: Rgba, lines: OcrLine[], pref: FontScript): Promise<Line[]> {
  const zh = pref === 'sc' || pref === 'tc'
  const out: Line[] = []
  for (const l of lines) {
    let kind = lineKind(l.text, l.conf)
    if (!zh && (pref === 'ko' || l.conf < 0.9 || kind === 'la' || kind === 'han')) {
      try {
        const ko = await loadOcrKo()
        const r = await recognize(stripOf(img, l.rect, 48), ko.rec, ko.dict)
        const hg = countKinds(r.text).hangul
        const cjkSure = (kind === 'ja' || kind === 'han') && l.conf >= r.conf
        if ((hg >= 2 && !cjkSure && (r.conf >= 0.7 || (r.conf >= 0.6 && r.conf > l.conf))) || (hg >= 1 && r.conf >= 0.8 && r.conf > l.conf)) {
          out.push({ ...l, ...r, sc: 'ko' })
          continue
        }
      } catch {
        /* without the Korean model, below */
      }
    }
    let sc: FontScript | null = null
    if (kind === 'ja') sc = 'ja'
    else if (kind === 'han') sc = zh ? pref : 'ja'
    else if (kind === 'gr') sc = 'gr'
    else if (kind === 'la') sc = pref === 'vi' ? 'vi' : 'la'
    const weak = l.conf < 0.65 && (kind === 'la' || kind === 'han')
    if (kind === 'la' || kind === 'other' || weak) {
      const wide = kind === 'other' || weak
      const cands: FontScript[] = wide ? ['la', 'cy', 'gr', 'ar', 'th', 'hi', ...(zh ? [] : (['ko', 'ja'] as FontScript[]))] : ['la', 'cy', 'gr']
      try {
        const sims = await lineSims(img, l.rect, cands)
        const base: FontScript = kind === 'la' ? 'la' : weak && sc ? sc : cands.includes(pref) ? pref : 'la'
        let best = base
        for (const c of cands) if ((sims[c] ?? -1) > (sims[best] ?? -1) + 0.03) best = c
        const own = OWN_OCR.includes(best)
        if (kind === 'other') {
          sc = own ? best : null
          kind = sc ? 'la' : 'other'
          if (sc) {
            out.push({ ...l, sc, guessed: true })
            continue
          }
        } else if (own && best !== sc) {
          out.push({ ...l, sc: best, guessed: true, fallback: sc ?? undefined })
          continue
        }
      } catch {
        /* as read */
      }
    }
    out.push({ ...l, sc })
  }
  for (let i = 0; i < out.length; i++) {
    const l = out[i]!
    if (!l.sc || !OWN_OCR.includes(l.sc)) continue
    try {
      const m = await loadOcrLang(l.sc as OcrLang)
      const r = await recognize(stripOf(img, l.rect, 48), m.rec, m.dict)
      const text = l.sc === 'ar' ? Array.from(r.text).reverse().join('') : r.text
      const sure = r.chars.length >= 2 && r.conf >= 0.7
      if (sure || (l.guessed && r.conf > l.conf)) out[i] = { ...l, text, conf: r.conf, chars: r.chars, guessed: sure ? false : l.guessed }
      else if (l.guessed && l.fallback) out[i] = { ...l, sc: l.fallback, guessed: false }
    } catch {
      /* as guessed */
    }
  }
  if (out.some((l) => l.sc && !l.guessed && hasLetters(l))) for (const l of out) if (l.guessed && l.sc !== pref) l.sc = l.fallback ?? null
  return out
}

function hasLetters(l: Line): boolean {
  if (l.sc === 'ar' || l.sc === 'cy' || l.sc === 'th' || l.sc === 'hi') return l.chars.length >= 2 || l.rect.len > l.rect.th * 2
  const k = countKinds(l.text)
  return k.kana + k.han + k.hangul + k.latin + k.greek > 0
}

function defaultLines(lines: Line[], pref: FontScript): Line[] {
  const ok = lines.filter((l) => l.sc && hasLetters(l))
  if (!ok.length) return []
  const tall = Math.max(...ok.map((l) => l.h))
  const mine = ok.filter((l) => l.sc === pref && l.h >= tall * 0.5)
  const pool = mine.length ? mine : ok
  const main = pool.reduce((a, l) => (l.h > a.h ? l : a), pool[0]!)
  return pool.filter((l) => l.sc === main.sc && Math.abs(l.h - main.h) <= main.h * 0.15 && Math.abs(l.rect.ang - main.rect.ang) < 0.09 && l.rect.vertical === main.rect.vertical).slice(0, 4)
}

function buildSheet(img: Rgba, lines: Line[]): { gray: Gray; strips: StripInfo[] } {
  const hOf = (l: Line) => (l.h >= 64 && l.h <= 200 ? l.h : Math.min(200, Math.max(64, l.h)))
  const gap = Math.round(Math.max(...lines.map(hOf)) * 0.25)
  const parts = lines.map((l) => {
    const rgb = stripOf(img, l.rect, hOf(l))
    return { rgb, gray: normalizeStrip(rgbaGray(rgb)), chars: l.chars, text: l.text }
  })
  const W = Math.max(...parts.map((p) => p.rgb.w)) + gap * 2
  const Ht = parts.reduce((a, p) => a + p.rgb.h, 0) + (parts.length + 1) * gap
  const g = new Uint8Array(W * Ht).fill(255)
  const strips: StripInfo[] = []
  let y0 = gap
  for (const p of parts) {
    for (let y = 0; y < p.rgb.h; y++) g.set(p.gray.data.subarray(y * p.gray.w, (y + 1) * p.gray.w), (y0 + y) * W + gap)
    strips.push({ y0, y1: y0 + p.rgb.h, w: p.rgb.w, chars: p.chars.map((ch) => ({ ...ch, x: (gap + ch.x * p.rgb.w) / p.rgb.w })), text: p.text })
    y0 += p.rgb.h + gap
  }
  return { gray: { w: W, h: Ht, data: g }, strips }
}

function assignOcr(glyphs: Glyph[], strips: StripInfo[]): (string | null)[] {
  const out: (string | null)[] = glyphs.map(() => null)
  for (const st of strips) {
    const idx = glyphs
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => {
        const cy = (g.box.y0 + g.box.y1) / 2
        return cy >= st.y0 && cy < st.y1
      })
      .sort((a, b) => a.g.box.x0 - b.g.box.x0)
    const cs = st.chars.filter((c) => c.p >= 0.5 && c.c.trim())
    if (!idx.length || !cs.length) continue
    if (idx.length === cs.length) idx.forEach(({ i }, k) => (out[i] = cs[k]!.c))
    else
      for (const { g, i } of idx) {
        const gw = g.box.x1 - g.box.x0
        const hit = cs.filter((c) => c.x * st.w >= g.box.x0 - gw * 0.2 && c.x * st.w <= g.box.x1 + gw * 0.2)
        if (hit.length === 1) out[i] = hit[0]!.c
      }
  }
  return out
}

function withSpaces(glyphs: Glyph[], chars: string[]): string {
  if (!glyphs.length) return ''
  const hs = glyphs.map((g) => g.box.y1 - g.box.y0).sort((a, b) => a - b)
  const em = hs[Math.floor(hs.length / 2)]!
  let out = chars[0] ?? ''
  for (let i = 1; i < glyphs.length; i++) {
    const a = glyphs[i - 1]!.box
    const b = glyphs[i]!.box
    if (b.y0 > a.y1 || b.x0 - a.x1 > em * 0.33) out += ' '
    out += chars[i] ?? ''
  }
  return out
}

function avgScores<T extends { score: number }>(a: T[], b: T[], key: (r: T) => string | number): T[] {
  const floor = (x: T[]) => (x.length ? x[Math.min(x.length - 1, 50)]!.score : 0)
  const fa = floor(a)
  const fb = floor(b)
  const mb = new Map(b.map((r) => [key(r), r]))
  const seen = new Set<string | number>()
  const out: T[] = []
  for (const r of a) {
    const k = key(r)
    seen.add(k)
    out.push({ ...r, score: (r.score + (mb.get(k)?.score ?? fb)) / 2 })
  }
  for (const r of b) if (!seen.has(key(r))) out.push({ ...r, score: (r.score + fa) / 2 })
  return out.sort((x, y) => y.score - x.score)
}

const sameRoot = (a: string, b: string) => a === b || a.split('-')[0] === b.split('-')[0]

async function readView(g: Gray, sc: FontScript, strips?: StripInfo[]): Promise<View> {
  const ink = toInk(g)
  const lines = extract(ink, sc)
  if (strips?.length && (sc === 'ko' || sc === 'ja' || sc === 'sc' || sc === 'tc')) {
    for (const l of lines) {
      const cy = (l.box.y0 + l.box.y1) / 2
      const st = strips.find((x) => cy >= x.y0 && cy < x.y1)
      if (!st) continue
      const em = l.box.y1 - l.box.y0
      const xs = st.chars.filter((c) => c.p >= 0.3 && c.c.trim()).map((c) => c.x * st.w).filter((x) => x >= l.box.x0 - em * 0.5 && x <= l.box.x1 + em * 0.5).sort((a, b) => a - b)
      const wOf = (gg: Glyph) => gg.box.x1 - gg.box.x0
      const extra = l.glyphs.length - xs.length
      const per = (l.box.x1 - l.box.x0) / Math.max(1, xs.length) / em
      const ok = per >= 0.6 && per <= 1.5 && (extra > 0 ? l.glyphs.some((gg) => wOf(gg) < em * 0.8) : extra < 0 ? l.glyphs.some((gg) => wOf(gg) > em * 1.3) : false)
      if (xs.length >= 1 && ok) {
        const gs = splitByChars(ink, l.box, xs)
        if (gs.length === xs.length) l.glyphs = gs
      }
    }
  }
  const meta = await loadMeta()
  if (!meta.scripts[sc]) {
    const ls = lines.filter((l) => l.glyphs.length)
    const read = (strips ?? []).map((x) => x.text?.trim() ?? '').filter(Boolean).join(' ')
    return { gray: g, lines: ls.length ? ls.map((l) => l.box) : [{ x0: 0, y0: 0, x1: g.w, y1: g.h }], lineGlyphs: [], glyphs: [], read, readScore: 0 }
  }
  const glyphs = lines.flatMap((l) => l.glyphs)
  const lineBoxes = lines.length ? lines.map((l) => l.box) : [{ x0: 0, y0: 0, x1: g.w, y1: g.h }]
  const lineGlyphs = lines.map((l) => l.glyphs.map((gg) => gg.box))
  let read = ''
  let readScore = 0
  let matchChars: string[] | undefined
  if (glyphs.length) {
    const both: FontScript[] = sc === 'cy' || sc === 'gr' || sc === 'vi' ? [sc, 'la'] : [sc]
    const refs = await Promise.all(both.map((s) => loadRef(s)))
    const readAll = (gg: Glyph, rs: (Ref16 | null)[]) => both.map((s, j) => (rs[j] ? readGlyph(gg, rs[j]!, meta.scripts[s].chars) : { char: '', score: -1 })).reduce((x, y) => (y.score > x.score ? y : x))
    const first = glyphs.map((gg) => readAll(gg, refs))
    let best = first
    const obs = glyphs.map((gg, i) => ({ glyph: gg, char: first[i]!.char })).filter((_, i) => first[i]!.score >= 0.5)
    const table = await tableFor(meta, sc, obs.map((o) => o.char))
    const top = rankFaces(obs, table).slice(0, 5).map((r) => r.face)
    const frs = await Promise.all(both.map((s) => fontRef(meta, s, top).catch(() => null)))
    if (frs.some(Boolean))
      best = glyphs.map((gg, i) => {
        const r = readAll(gg, frs)
        return r.score >= first[i]!.score - 0.02 ? r : first[i]!
      })
    if (strips?.length) {
      const oc = assignOcr(glyphs, strips)
      const cs = meta.scripts[sc]?.chars ?? ''
      matchChars = best.map((r, i) => (oc[i] === null ? r.char : cs.includes(oc[i]!) ? oc[i]! : ''))
      best = best.map((r, i) => (oc[i] !== null ? { ...r, char: oc[i]! } : r))
    }
    read = withSpaces(glyphs, best.map((r) => r.char))
    readScore = best.reduce((a, r) => a + r.score, 0) / best.length
  }
  return { gray: g, lines: lineBoxes, lineGlyphs, glyphs, read, readScore, chars: matchChars }
}

export interface FontMatch {
  rank: number
  name: string
  nameKo?: string
  nameJa?: string
  designer?: string
  similarity: number
  weight: number
  price: 'free' | 'paid' | 'os'
  licence?: string
  /** the family's page on ezpzfile.com */
  page: string
  /** where to get it: Google Fonts, the maker, the shop */
  source: string
  /** direct font files when the source publishes them (Google Fonts TTF per weight) */
  files?: Record<string, string>
  preview?: string
}

export interface FontFindResult {
  script: FontScript
  read: string
  glyphs: number
  lines: { text: string; box: Box; script: FontScript | null }[]
  confidence: 'high' | 'mid' | 'low' | null
  matches: FontMatch[]
}

/**
 * Find the fonts in a picture. `region` limits it to a box (px of the picture), `text`
 * corrects what the OCR read (same order as the letters), `script` forces the script.
 */
export async function findFont(bytes: Uint8Array, opts: { region?: Box; text?: string; script?: FontScript; limit?: number; prefer?: FontScript }): Promise<FontFindResult> {
  await prepareOrt()
  const shot = await readImage(bytes)
  const pref: FontScript = opts.script ?? opts.prefer ?? 'ko'
  const region = opts.region ? { x0: Math.max(0, Math.round(opts.region.x0)), y0: Math.max(0, Math.round(opts.region.y0)), x1: Math.min(shot.w, Math.round(opts.region.x1)), y1: Math.min(shot.h, Math.round(opts.region.y1)) } : undefined
  let found: Line[]
  try {
    found = await assignScripts(shot.rgba, await readLines(shot.rgba, region), pref)
  } catch (err) {
    throw new ToolError('ENGINE', `The font finder's models could not be loaded from ff.ezpzfile.com: ${(err as Error).message}`, ['network access to ff.ezpzfile.com'])
  }
  let sc: FontScript = pref
  const usable = found.filter((l) => (l.sc || opts.script) && l.text.trim())
  if (!usable.length) throw new ToolError('NOT_APPLIED', 'No line of text was found in the picture. Give region: the box around the text, in pixels.', ['region'])
  if (opts.script) sc = opts.script
  else {
    const by = new Map<FontScript, number>()
    for (const l of usable) if (l.sc) by.set(l.sc, (by.get(l.sc) ?? 0) + l.chars.length)
    if (!by.has(sc)) sc = [...by.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  }
  const lines = defaultLines(opts.script ? usable.map((l) => ({ ...l, sc })) : usable.filter((l) => l.sc === sc), sc)
  if (!lines.length) throw new ToolError('NOT_APPLIED', 'The text lines found have no letters to compare (numbers or symbols only).', ['region'])
  const sheet = buildSheet(shot.rgba, lines)
  const view = await readView(sheet.gray, sc, sheet.strips)
  const ocrText = sc !== 'vi' && lines.every((l) => l.conf >= 0.6) ? lines.map((l) => l.text.trim()).join(' ') : ''
  const read = ocrText || view.read

  // scoring: as the site's find()
  const meta = await loadMeta()
  const lists = await Promise.all([loadList(sc), sc === 'la' ? Promise.resolve([]) : loadList('la'), loadPaidList(sc).then((l) => l.filter((f) => f.f.length))])
  const byFace = new Map<number, FontFamily>()
  const famByKey = new Map<string, FontFamily>()
  for (const l of lists)
    for (const f of l) {
      famByKey.set(f.k, f)
      for (const fi of f.f) if (!byFace.has(fi)) byFace.set(fi, f)
    }
  const alpha = ML_ALPHA[sc] ?? 0.6
  const typed = opts.text ? Array.from(opts.text.replace(/\s/g, '')) : []
  const own = view.chars ?? Array.from(read.replace(/\s/g, ''))
  const chars = typed.length === view.glyphs.length ? typed : own.length === view.glyphs.length ? own : typed.length ? typed : own

  const mlRes = await modelRank(view.gray, view.lines, sc, view.lineGlyphs.length ? view.lineGlyphs : undefined).catch(() => null)
  const hollow = isHollowLine(view.glyphs)
  const obs: Observed[] = view.glyphs.map((g, i) => ({ glyph: hollow ? fillHoles(g) : g, char: chars[i]! })).filter((o) => o.char)
  const obs2: Observed[] = hollow
    ? view.glyphs.flatMap((g, i) => {
        const b = chars[i] ? innerBody(g) : null
        return b ? [{ glyph: b, char: chars[i]! }] : []
      })
    : []
  const noPg = { scores: [] as PaidGlyphScore[], covered: new Set<string>() }
  const pg = (o: Observed[]) => (o.length ? rankPaidGlyph(o, sc).catch(() => noPg) : Promise.resolve(noPg))
  const { scores: paidGlyph, covered: pgCovered } = obs2.length ? await Promise.all([pg(obs), pg(obs2)]).then(([a, b]) => ({ scores: avgScores(a.scores, b.scores, (r) => r.k), covered: a.covered })) : await pg(obs)
  const table = obs.length ? await tableFor(meta, sc, [...obs, ...obs2].map((o) => o.char)) : null
  const ranked = table ? (obs2.length ? avgScores(rankFaces(obs, table), rankFaces(obs2, table), (r) => r.face) : rankFaces(obs, table)) : []
  const ml = mlRes?.free ?? null
  const glyphBest = new Map<string, { score: number; face: number }>()
  for (const r of ranked) {
    const fam = byFace.get(r.face)
    if (fam && !glyphBest.has(fam.k)) glyphBest.set(fam.k, { score: r.score, face: r.face })
  }
  const paidR = mlRes?.paid ?? []
  const mlBest = new Map<string, { sim: number; weight: number }>((ml ?? []).map((r) => [r.k, r]))
  for (const r of paidR) if (glyphBest.has(r.f.k) && !mlBest.has(r.f.k)) mlBest.set(r.f.k, r)
  const gMin = ranked.length ? ranked[Math.min(ranked.length - 1, 50)]!.score : 0
  const mMin = ml?.length ? ml[Math.min(ml.length - 1, 50)]!.sim : 0
  const useMl = !!ml?.length
  const useGlyph = ranked.length > 0
  const out: Match[] = []
  for (const k of new Set<string>([...glyphBest.keys(), ...(ml ?? []).map((r) => r.k)])) {
    const fam = famByKey.get(k)
    if (!fam) continue
    const g = glyphBest.get(k)
    const m = mlBest.get(k)
    const score = useMl && useGlyph ? alpha * (m?.sim ?? mMin) + (1 - alpha) * (g?.score ?? gMin) : useMl ? (m?.sim ?? mMin) : (g?.score ?? 0)
    out.push({ fam, face: g?.face ?? -1, score, weight: g ? (meta.faces[g.face]?.weight ?? 400) : (m?.weight ?? 400) })
  }
  const paidDone = new Set<string>()
  const pMin = paidGlyph.length ? paidGlyph[Math.min(paidGlyph.length - 1, 50)]!.score : 0
  for (const r of paidGlyph.slice(0, 200)) {
    const fam = mlRes?.paidByKey.get(r.k)
    if (!fam || glyphBest.has(r.k)) continue
    const m = mlRes?.paidAll.get(r.k)
    paidDone.add(r.k)
    out.push({ fam, face: -1, score: useMl ? alpha * (m?.sim ?? mMin) + (1 - alpha) * r.score : r.score, weight: m?.weight ?? 400 })
  }
  if (useMl && paidR.length) {
    const line = fitLine((ml ?? []).slice(0, 60).filter((r) => glyphBest.has(r.k)).map((r) => [r.sim, glyphBest.get(r.k)!.score] as [number, number]))
    for (const r of paidR) {
      if (glyphBest.has(r.f.k) || paidDone.has(r.f.k)) continue
      if (pgCovered.has(r.f.k)) {
        out.push({ fam: r.f, face: -1, score: alpha * r.sim + (1 - alpha) * pMin, weight: r.weight })
        continue
      }
      out.push({ fam: r.f, face: -1, score: useGlyph ? paidScore(r.sim, line, PAID_DELTA, alpha) : r.sim + PAID_DELTA, weight: r.weight })
    }
  }
  out.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const best = out.filter((m) => (seen.has(m.fam.k) ? false : (seen.add(m.fam.k), true)))

  let confidence: FontFindResult['confidence'] = null
  if (best[0]) {
    const glyphTop = ranked.length ? byFace.get(ranked[0]!.face)?.k : undefined
    const mlTop = ml?.[0]?.k
    const gap = best[0].score - (best[1]?.score ?? 0)
    const few = view.glyphs.length < 3 && gap < 0.08
    confidence = !useMl ? (best[0].score >= 0.85 ? 'high' : best[0].score >= 0.75 ? 'mid' : 'low') : few ? 'low' : glyphTop && mlTop && sameRoot(glyphTop, mlTop) && (sameRoot(glyphTop, best[0].fam.k) || sameRoot(mlTop, best[0].fam.k)) ? 'high' : gap >= 0.04 ? 'mid' : 'low'
    if (confidence === 'low' && best[0].score >= 0.9) confidence = 'mid'
  }

  const price = (f: FontFamily): FontMatch['price'] => (f.src === 'o' ? 'os' : f.src === 'p' && !f.p?.f ? 'paid' : 'free')
  const matches: FontMatch[] = best.slice(0, opts.limit ?? 10).map((m, i) => ({
    rank: i + 1,
    name: m.fam.name,
    ...(m.fam.ko && m.fam.ko !== m.fam.name ? { nameKo: m.fam.ko } : {}),
    ...(m.fam.ja && m.fam.ja !== m.fam.name ? { nameJa: m.fam.ja } : {}),
    ...(m.fam.by ? { designer: m.fam.by } : {}),
    similarity: Math.round(m.score * 1000) / 10,
    weight: m.weight,
    price: price(m.fam),
    ...(m.fam.src === 'g' ? { licence: 'SIL Open Font License' } : m.fam.x?.l ? { licence: m.fam.x.l } : {}),
    page: `https://ezpzfile.com/fonts/${encodeURIComponent(m.fam.s)}`,
    source: m.fam.src === 'p' ? m.fam.p?.u ?? '' : m.fam.src === 'o' ? `installed with ${m.fam.o?.os === 'win' ? 'Windows' : 'macOS'}` : officialUrl(m.fam),
    ...(m.fam.dl ? { files: m.fam.dl } : {}),
    ...(m.fam.pv ? { preview: previewUrl(pvFor(m.fam, sc)).replace(/ /g, '%20') } : {}),
  }))
  return { script: sc, read, glyphs: view.glyphs.length, lines: lines.map((l) => ({ text: l.text, box: l.box, script: l.sc })), confidence, matches }
}
