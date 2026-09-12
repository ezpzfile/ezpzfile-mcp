/**
 * 변환 알맹이. 브라우저 쪽과 같은 규칙(hwpScan)과 같은 그리기 코드(svgPdf)를 쓴다.
 * 다른 것은 파일을 가져오는 방법뿐이다.
 */
import PDFDocument from 'pdfkit'
import * as fontkit from 'fontkit'
import { LOOKALIKE, needsCjkFont, scanDocument } from '../../src/lib/hwpScan'
import { PX_TO_PT, paintSvg, type FontChooser, type PaintReport } from '../../src/lib/svgPdf'
import { pageToText } from './text'
import {
  HwpDocError,
  installDom,
  loadEngine,
  loadFont,
  openDocument,
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

/** HWP·HWPX → PDF. 글자를 그림으로 굽지 않고 벡터로 옮긴다. */
export async function hwpToPdf(
  bytes: Uint8Array,
  password?: string,
): Promise<{ pdf: Uint8Array; stats: ConvertStats }> {
  installDom()
  const engine = await loadEngine()
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

    const fonts: FontChooser = {
      pick(char, serif) {
        for (const candidate of [char, LOOKALIKE[char]]) {
          if (candidate === undefined) continue
          const codePoint = candidate.codePointAt(0)!
          for (const f of order(serif)) {
            if (f && f.has(codePoint)) return { font: f.key, char: candidate }
          }
        }
        return null
      },
    }

    const report: PaintReport = { missingGlyphs: 0, skipped: 0 }
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
      stats: { pages, missingGlyphs: report.missingGlyphs, skipped: report.skipped },
    }
  } finally {
    doc.free()
  }
}

/** HWP ↔ HWPX. 그릇만 바꾼다. 쓰고 나서 되읽어 쪽수를 대조한다. */
export async function convertContainer(
  bytes: Uint8Array,
  target: 'hwp' | 'hwpx',
  password?: string,
): Promise<{ out: Uint8Array; stats: ConvertStats }> {
  const engine = await loadEngine()
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
    exported.free()
  } finally {
    doc.free()
  }

  let pageMatch = true
  try {
    const again = openDocument(engine, out, password)
    try {
      pageMatch = again.pageCount() === pages
    } finally {
      again.free()
    }
  } catch {
    pageMatch = false
  }

  return { out, stats: { pages, lost, pageMatch } }
}

/** 본문을 글자로 꺼낸다. 에이전트가 읽을 수 있게 하는 것이 목적이다. */
export async function readDocument(
  bytes: Uint8Array,
  password?: string,
): Promise<{ text: string; pages: number; fontsUsed: string[]; encrypted: boolean }> {
  const engine = await loadEngine()
  const doc = openDocument(engine, bytes, password)
  try {
    const pages = doc.pageCount()
    const info = JSON.parse(doc.getDocumentInfo()) as {
      fontsUsed?: string[]
      encrypted?: boolean
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
      text: parts.join('\n\n'),
      pages,
      fontsUsed: info.fontsUsed ?? [],
      encrypted: Boolean(info.encrypted),
    }
  } finally {
    doc.free()
  }
}

export { HwpDocError }
export type { HwpDocument }
