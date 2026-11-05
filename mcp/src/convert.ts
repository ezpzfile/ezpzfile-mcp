/**
 * 변환 알맹이. 브라우저 쪽과 같은 규칙(hwpScan)과 같은 그리기 코드(svgPdf)를 쓴다.
 * 다른 것은 파일을 가져오는 방법뿐이다.
 */
import { existsSync, readFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import * as fontkit from 'fontkit'
import { LOOKALIKE, needsCjkFont, scanDocument } from '../../src/lib/hwpScan'
import { PX_TO_PT, paintSvg, type FontChooser, type PaintReport } from '../../src/lib/svgPdf'
import { pageToText } from './text'
import { hwpStructureToDocx } from './hwpDocx'
import { hwpToMarkdown, parseHwpx, structureSummary, type HwpStructure } from './hwpStructure'
import {
  HwpDocError,
  freeDoc,
  installDom,
  isEngineTrap,
  loadFont,
  openDocument,
  withEngine,
  type FontKey,
  type HwpDocument,
} from './engine'

export interface ConvertStats {
  pages: number
  /** 엔진이 옮기지 못했다고 보고한 요소 수 */
  lost?: number
  /** 만든 파일을 되읽었을 때 쪽수가 원본과 같았는가 */
  pageMatch?: boolean
  /** 글꼴에 없어 빠진 글자 수 */
  missingGlyphs?: number
  /** 빠진 글자 목록(코드 포인트) */
  missingChars?: string[]
  /** 대신 쓴 이 컴퓨터의 글꼴 */
  systemFonts?: string[]
  /** 우리가 옮기지 못한 그리기 요소 수 */
  skipped?: number
}

interface Face {
  key: FontKey
  bytes: Uint8Array
  has: (codePoint: number) => boolean
}

const faceCache = new Map<FontKey, Face>()

function face(key: FontKey): Face {
  let cached = faceCache.get(key)
  if (!cached) {
    const bytes = loadFont(key)
    const parsed = fontkit.create(bytes) as unknown as {
      hasGlyphForCodePoint(codePoint: number): boolean
    }
    cached = { key, bytes, has: (cp: number) => parsed.hasGlyphForCodePoint(cp) }
    faceCache.set(key, cached)
  }
  return cached
}

/**
 * 들어 있는 글꼴에 없는 글자를 이 컴퓨터의 글꼴로 대신 그린다. 기호·옛한글이 많은 글꼴부터 본다.
 * EZPZFILE_FONTS 에 글꼴 파일 경로를 (: 또는 ; 로) 적으면 그것을 먼저 쓴다.
 */
const SYSTEM_FONTS = [
  // macOS
  '/Library/Fonts/HCRBatang.ttf', '/Library/Fonts/HANBatang.ttf',
  '/System/Library/Fonts/Apple Symbols.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/AppleSDGothicNeo.ttc',
  // Windows
  'C:\\Windows\\Fonts\\HCRBatang.ttf', 'C:\\Windows\\Fonts\\HANBatang.ttf', 'C:\\Windows\\Fonts\\seguisym.ttf',
  'C:\\Windows\\Fonts\\malgun.ttf', 'C:\\Windows\\Fonts\\arialuni.ttf', 'C:\\Windows\\Fonts\\msgothic.ttc',
  // Linux
  '/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/unifont/unifont.otf', '/usr/share/fonts/opentype/unifont/unifont_csur.otf',
]

interface SysFace {
  key: string
  path: string
  name?: string
  has: (codePoint: number) => boolean
}

let sysFaces: SysFace[] | null = null

function systemFaces(): SysFace[] {
  if (sysFaces) return sysFaces
  const extra = (process.env.EZPZFILE_FONTS ?? '').split(/[;:](?![\\/])/).filter(Boolean)
  sysFaces = []
  for (const path of [...extra, ...SYSTEM_FONTS]) {
    try {
      if (!existsSync(path)) continue
      const parsed = fontkit.create(readFileSync(path)) as unknown as {
        fonts?: { postscriptName: string; hasGlyphForCodePoint(cp: number): boolean }[]
        postscriptName?: string
        hasGlyphForCodePoint?(cp: number): boolean
      }
      const one = parsed.fonts ? parsed.fonts[0] : (parsed as { postscriptName: string; hasGlyphForCodePoint(cp: number): boolean })
      if (!one?.hasGlyphForCodePoint) continue
      sysFaces.push({ key: `sys${sysFaces.length}`, path, name: parsed.fonts ? one.postscriptName : undefined, has: (cp) => one.hasGlyphForCodePoint(cp) })
    } catch {
      // 읽지 못하는 글꼴은 건너뛴다
    }
  }
  return sysFaces
}

/**
 * 기호 글꼴(Wingdings)의 글자는 HWP 에 U+F0xx 사용자 정의 자리로 들어온다. 동그라미 숫자만 유니코드로 옮긴다.
 * 0x80~0x8A ⓪①…⑩, 0x8B ⓿, 0x8C~0x95 ❶…❿. 다른 자리는 글꼴마다 뜻이 달라 건드리지 않는다.
 */
export function symbolPua(ch: string): string | undefined {
  const cp = ch.codePointAt(0)!
  if (cp === 0xf080) return '\u24ea'
  if (cp > 0xf080 && cp <= 0xf08a) return String.fromCodePoint(0x2460 + cp - 0xf081)
  if (cp === 0xf08b) return '\u24ff'
  if (cp >= 0xf08c && cp <= 0xf095) return String.fromCodePoint(0x2776 + cp - 0xf08c)
  return undefined
}

export const fixSymbolPua = (t: string) => t.replace(/[\uf080-\uf095]/g, (c) => symbolPua(c) ?? c)

/** 빠진 글자를 'U+F02B1(2)' 처럼 적는다. 많이 빠진 것부터. */
export function describeMissing(m: Map<string, number>): string[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ch, n]) => {
      const cp = ch.codePointAt(0)!
      const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
      const pua = (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000
      return `${code}${pua ? ' (private use)' : ` "${ch}"`}${n > 1 ? ` ×${n}` : ''}`
    })
}

/** HWP·HWPX → PDF. 글자를 그림으로 굽지 않고 벡터로 옮긴다. */
export async function hwpToPdf(
  bytes: Uint8Array,
  password?: string,
): Promise<{ pdf: Uint8Array; stats: ConvertStats }> {
  installDom()
  return withEngine(async (engine) => {
  const doc = openDocument(engine, bytes, password)

  try {
    const pages = doc.pageCount()
    if (pages < 1) throw new HwpDocError('EMPTY')

    const scan = scanDocument(doc, pages)
    const faces: Face[] = []
    if (scan.sans || !scan.serif) faces.push(face('gothic'))
    if (scan.serif) faces.push(face('myeongjo'))
    if (needsCjkFont(scan, faces.map((f) => f.has))) faces.push(face('cjk'))

    const pdf = new PDFDocument({ autoFirstPage: false, compress: true, font: null })
    const chunks: Uint8Array[] = []
    pdf.on('data', (chunk) => chunks.push(chunk))
    const finished = new Promise<void>((resolve) => pdf.on('end', () => resolve()))
    for (const f of faces) pdf.registerFont(f.key, f.bytes)

    const byKey = (key: FontKey) => faces.find((f) => f.key === key)
    const order = (serif: boolean) =>
      serif
        ? [byKey('myeongjo'), byKey('gothic'), byKey('cjk')]
        : [byKey('gothic'), byKey('myeongjo'), byKey('cjk')]

    const usedSys = new Map<string, string>()
    const fonts: FontChooser = {
      pick(char, serif) {
        for (const candidate of [char, LOOKALIKE[char], symbolPua(char)]) {
          if (candidate === undefined) continue
          const codePoint = candidate.codePointAt(0)!
          for (const f of order(serif)) {
            if (f && f.has(codePoint)) return { font: f.key, char: candidate }
          }
        }
        // 이 컴퓨터의 글꼴로
        if (process.env.EZPZFILE_NO_SYSTEM_FONTS !== '1') {
          const codePoint = char.codePointAt(0)!
          // 사용자 정의 자리는 글꼴마다 뜻이 달라, 한컴 글꼴에서만 찾는다
          const pua = (codePoint >= 0xe000 && codePoint <= 0xf8ff) || codePoint >= 0xf0000
          for (const f of systemFaces()) {
            if (pua && !/HCR|HAN/i.test(f.path)) continue
            if (!f.has(codePoint)) continue
            if (!usedSys.has(f.key)) {
              pdf.registerFont(f.key, f.path, f.name as string)
              usedSys.set(f.key, f.path)
            }
            return { font: f.key, char }
          }
        }
        return null
      },
    }

    const report: PaintReport = { missingGlyphs: 0, skipped: 0, missingChars: new Map() }
    const parser = new DOMParser()

    for (let index = 0; index < pages; index += 1) {
      const source = doc.renderPageSvgWithProfile(index, 'print')
      const svg = parser.parseFromString(source, 'image/svg+xml')
        .documentElement as unknown as SVGSVGElement
      const width = Number.parseFloat(svg.getAttribute('width') ?? '0') || 793.7
      const height = Number.parseFloat(svg.getAttribute('height') ?? '0') || 1122.5
      pdf.addPage({ size: [width * PX_TO_PT, height * PX_TO_PT], margin: 0 })
      pdf.scale(PX_TO_PT)
      paintSvg(pdf, svg, fonts, report)
    }

    pdf.end()
    await finished

    return {
      pdf: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      stats: {
        pages,
        missingGlyphs: report.missingGlyphs,
        missingChars: describeMissing(report.missingChars!),
        systemFonts: [...new Set(usedSys.values())],
        skipped: report.skipped,
      },
    }
  } finally {
    freeDoc(doc)
  }
  })
}

/** HWP ↔ HWPX. 그릇만 바꾼다. 쓰고 나서 되읽어 쪽수를 대조한다. */
export async function convertContainer(
  bytes: Uint8Array,
  target: 'hwp' | 'hwpx',
  password?: string,
): Promise<{ out: Uint8Array; stats: ConvertStats }> {
  return withEngine((engine) => {
  const doc = openDocument(engine, bytes, password)

  let out: Uint8Array
  let lost = 0
  let pages: number
  try {
    pages = doc.pageCount()
    if (pages < 1) throw new HwpDocError('EMPTY')

    // 암호가 걸린 문서였다면 결과에도 같은 암호를 건다.
    const exported =
      target === 'hwp'
        ? password
          ? doc.exportHwpWithPasswordAndReport(password)
          : doc.exportHwpWithReport()
        : password
          ? doc.exportHwpxWithPasswordAndReport(password)
          : doc.exportHwpxWithReport()

    try {
      lost = (JSON.parse(exported.contentLoss()) as { count?: number }).count ?? 0
    } catch {
      // 보고서를 읽지 못해도 변환 자체는 끝난 상태다.
    }
    out = exported.takeBytes()
    freeDoc(exported)
  } finally {
    freeDoc(doc)
  }

  let pageMatch = true
  try {
    const again = openDocument(engine, out, password)
    try {
      pageMatch = again.pageCount() === pages
    } finally {
      freeDoc(again)
    }
  } catch {
    pageMatch = false
  }

  return { out, stats: { pages, lost, pageMatch } }
  })
}

/**
 * 본문을 글자로 꺼낸다. 에이전트가 읽을 수 있게 하는 것이 목적이다.
 *
 * 표나 글상자가 있으면 구조째 읽는다(hwpStructure.ts): 표는 칸 주소대로, 병합·표 안의 표는 HTML 표로,
 * 글상자는 놓인 자리에 띄어쓰기째. 표·글상자가 없는 문서는 예전 그대로(쪽을 그려 줄을 되살린 글).
 */
export async function readDocument(
  bytes: Uint8Array,
  password?: string,
  format: 'text' | 'markdown' | 'json' = 'text',
): Promise<{ text: string; pages: number; fontsUsed: string[]; encrypted: boolean; structure: HwpStructure['stats'] | null; json?: HwpStructure }> {
  return withEngine((engine) => {
  const doc = openDocument(engine, bytes, password)
  try {
    const pages = doc.pageCount()
    const info = JSON.parse(doc.getDocumentInfo()) as {
      fontsUsed?: string[]
      encrypted?: boolean
    }
    let structure: HwpStructure | null = null
    try {
      structure = parseHwpx(doc.exportHwpx())
    } catch (err) {
      if (isEngineTrap(err)) throw err
      structure = null
    }
    const s = structure
    if (s && (format === 'json' || s.stats.tables + s.stats.textBoxes > 0)) {
      const body = format === 'json' ? JSON.stringify({ sections: s.sections, footnotes: s.footnotes }) : hwpToMarkdown(s, format)
      return {
        text: fixSymbolPua(`${structureSummary(s, format)}\n\n${body}`),
        pages,
        fontsUsed: info.fontsUsed ?? [],
        encrypted: Boolean(info.encrypted),
        structure: s.stats,
        json: format === 'json' ? s : undefined,
      }
    }
    // 쪽마다 렌더해서 글자를 되살린다. getPageText 는 표 안의 글자를 빠뜨린다.
    const parts: string[] = []
    for (let index = 0; index < pages; index += 1) {
      try {
        parts.push(pageToText(doc.renderPageSvgWithProfile(index, 'print')))
      } catch {
        try {
          parts.push(doc.getPageText(index))
        } catch {
          parts.push('')
        }
      }
    }
    return {
      text: fixSymbolPua(parts.join("\n\n")),
      pages,
      fontsUsed: info.fontsUsed ?? [],
      encrypted: Boolean(info.encrypted),
      structure: s ? s.stats : null,
    }
  } finally {
    freeDoc(doc)
  }
  })
}

export { HwpDocError }
export type { HwpDocument }

/** HWP·HWPX → DOCX. 표·병합·표 안의 표·글상자를 구조째 옮긴다(hwpDocx.ts). */
export async function hwpToDocx(
  bytes: Uint8Array,
  password?: string,
): Promise<{ docx: Uint8Array; stats: ConvertStats & { tables: number; tablesBack: number; mergedCells: number; textBoxes: number } }> {
  const structure = await withEngine((engine) => {
    const doc = openDocument(engine, bytes, password)
    try {
      return { s: parseHwpx(doc.exportHwpx()), pages: doc.pageCount() }
    } finally {
      freeDoc(doc)
    }
  })
  const { docx, stats } = await hwpStructureToDocx(structure.s)
  return {
    docx,
    stats: { pages: structure.pages, tables: stats.tables, tablesBack: stats.tablesBack, mergedCells: structure.s.stats.mergedCells, textBoxes: structure.s.stats.textBoxes },
  }
}
