/**
 * PDF 를 한글 문서로 되돌린다.
 *
 * hwpPdfOps 의 반대 방향이다. 그쪽은 문서를 쪽으로 굽는 일이라 원본이 완전하게
 * 남지만, 이쪽은 구운 쪽에서 문서를 되살리는 일이라 추측이 들어간다. 무엇이
 * 문단이었고 무엇이 표였는지는 PDF 안에 적혀 있지 않다(pdfLayout 참고).
 *
 * 되살린 뒤에는 rhwp 엔진에 빈 문서를 하나 만들게 하고 거기에 차곡차곡 넣는다.
 * 그림으로 박아 넣는 것이 아니라 진짜 문단과 표로 넣으므로, 받은 파일을 한글에서
 * 그대로 고칠 수 있다.
 *
 * 마지막에 모든 문단과 셀에 글자·문단 서식을 한 번씩 건다. 장식이 목적이 아니다.
 * 내장 빈 문서의 DocInfo 에는 쪽 나누기와 표가 참조하는 서식 ID 가 등록되어 있지
 * 않아서, 이 과정을 빼면 내보내기가 "미등록 ID 참조" 로 실패한다. 서식을 걸면
 * 엔진이 그 ID 를 등록한다.
 */
import { extractPdfLayout, PdfTextError, type PdfLayout } from './pdfLayout'
import { freeDoc, withEngine, type HwpDocument, type RhwpModule } from './rhwp'

export type HwpTarget = 'hwp' | 'hwpx'

export type PdfHwpPhase = 'reading' | 'engine' | 'writing' | 'verifying'

export interface PdfHwpProgress {
  phase: PdfHwpPhase
  /** 내려받는 중일 때만 0~1. 모르면 null */
  ratio: number | null
  page?: number
  pages?: number
}

export interface PdfHwpResult {
  blob: Blob
  stats: {
    /** 만든 한글 문서의 쪽수 */
    pages: number
    paragraphs: number
    tables: number
    images: number
    /** 글자가 없어 건너뛴 원본 쪽 번호. 대개 스캔한 쪽이다. */
    emptyPages: number[]
    /** 엔진이 옮기지 못했다고 보고한 요소 수 */
    lost: number
    /** 만든 파일을 되읽어 문단 수가 그대로였는가 */
    verified: boolean
  }
}

export interface PdfHwpOptions {
  password?: string
  onProgress?: (progress: PdfHwpProgress) => void
}

const MIME: Record<HwpTarget, string> = {
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
}

/** 문서에 넣을 알맹이 한 덩이. */
type Item =
  | { kind: 'text'; text: string; heading: boolean; pageBreakAfter: boolean }
  | { kind: 'table'; rows: string[][] }
  | {
      kind: 'image'
      bytes: Uint8Array
      /** 쪽에 찍혀 있던 크기(pt) */
      width: number
      height: number
      naturalWidth: number
      naturalHeight: number
    }

/** 되살린 쪽을 넣을 순서대로 편다. */
function toItems(layout: PdfLayout): Item[] {
  const items: Item[] = []
  const filled = layout.pages.filter((page) => page.blocks.length > 0)

  for (const [index, page] of filled.entries()) {
    const last = index === filled.length - 1
    for (const [i, block] of page.blocks.entries()) {
      const lastOfPage = i === page.blocks.length - 1
      if (block.kind === 'table' || block.kind === 'image') {
        items.push(
          block.kind === 'table'
            ? { kind: 'table', rows: block.rows }
            : {
                kind: 'image',
                bytes: block.bytes,
                width: block.width,
                height: block.height,
                naturalWidth: block.naturalWidth,
                naturalHeight: block.naturalHeight,
              },
        )
        // 표와 그림 뒤에 쪽을 나눠야 하면 붙일 문단이 따로 필요하다.
        if (lastOfPage && !last) {
          items.push({ kind: 'text', text: '', heading: false, pageBreakAfter: true })
        }
      } else {
        items.push({
          kind: 'text',
          text: block.text,
          heading: block.heading,
          pageBreakAfter: lastOfPage && !last,
        })
      }
    }
  }

  return items
}

/** 제목 글자 크기. 한글은 1/100 pt 단위를 쓴다. */
const HEADING_HEIGHT = 1600
const BODY_HEIGHT = 1000

/** 한글의 길이 단위(HWPUNIT)는 1/7200 인치다. 1포인트가 100 HU. */
const HU_PER_POINT = 100

/** A4 세로에서 여백을 뺀 본문 너비(pt). 이보다 넓은 그림은 비율을 지켜 줄인다. */
const TEXT_WIDTH_POINTS = 451

function fillDocument(doc: HwpDocument, items: Item[]): { tables: number; images: number } {
  // 본문 문단을 미리 다 만들어 두고 앞에서부터 채운다. 하나씩 만들며 채우면
  // 새 문단이 앞에 끼어들어 순서가 뒤집힌다.
  for (let i = 1; i < items.length; i += 1) doc.insertParagraph(0, 0)

  let tables = 0
  let images = 0
  const breaks: Array<{ para: number; offset: number }> = []

  for (const [index, item] of items.entries()) {
    if (item.kind === 'image') {
      let width = item.width
      let height = item.height
      if (width > TEXT_WIDTH_POINTS) {
        height = (height * TEXT_WIDTH_POINTS) / width
        width = TEXT_WIDTH_POINTS
      }
      const result = doc.insertPicture(
        0,
        index,
        0,
        '',
        item.bytes,
        Math.max(1, Math.round(width * HU_PER_POINT)),
        Math.max(1, Math.round(height * HU_PER_POINT)),
        item.naturalWidth,
        item.naturalHeight,
        'png',
        '',
      )
      if ((JSON.parse(result) as { ok?: boolean }).ok) images += 1
      continue
    }

    if (item.kind === 'table') {
      const columns = Math.max(...item.rows.map((row) => row.length), 1)
      const info = JSON.parse(doc.createTable(0, index, 0, item.rows.length, columns)) as {
        ok?: boolean
        paraIdx?: number
        controlIdx?: number
      }
      if (!info.ok || info.paraIdx === undefined || info.controlIdx === undefined) continue
      tables += 1

      let cell = 0
      for (const row of item.rows) {
        for (let c = 0; c < columns; c += 1) {
          const value = row[c] ?? ''
          if (value) {
            doc.insertTextInCell(0, info.paraIdx, info.controlIdx, cell, 0, 0, value)
          }
          // 서식을 걸어야 셀 문단의 서식 ID 가 등록된다.
          doc.applyCharFormatInCell(
            0,
            info.paraIdx,
            info.controlIdx,
            cell,
            0,
            0,
            Math.max(value.length, 1),
            JSON.stringify({ bold: false, height: BODY_HEIGHT }),
          )
          doc.applyParaFormatInCell(
            0,
            info.paraIdx,
            info.controlIdx,
            cell,
            0,
            JSON.stringify({ align: 'left' }),
          )
          cell += 1
        }
      }
      continue
    }

    if (item.text) doc.insertText(0, index, 0, item.text)
    if (item.heading && item.text) {
      doc.applyCharFormat(
        0,
        index,
        0,
        item.text.length,
        JSON.stringify({ bold: true, height: HEADING_HEIGHT }),
      )
    }
    if (item.pageBreakAfter) breaks.push({ para: index, offset: item.text.length })
  }

  // 쪽 나누기는 본문을 다 채운 뒤에 넣는다. 먼저 넣으면 뒤따르는 insertText 의
  // 문단 번호가 밀린다.
  for (const at of breaks.reverse()) doc.insertPageBreak(0, at.para, at.offset)

  // 모든 본문 문단에 서식을 한 번씩 건다. 위 주석의 ID 등록 때문이다.
  // 그림만 든 문단처럼 글자가 없는 자리에서는 실패할 수 있는데, 그때는 등록할
  // 것도 없으므로 그냥 넘어간다. 여기서 던지면 변환 전체가 멈춘다.
  const count = doc.getParagraphCount(0)
  for (let i = 0; i < count; i += 1) {
    try {
      doc.applyCharFormat(0, i, 0, 1, JSON.stringify({ height: BODY_HEIGHT }))
    } catch {
      // 등록할 글자가 없는 문단
    }
    try {
      doc.applyParaFormat(0, i, JSON.stringify({ align: 'left' }))
    } catch {
      // 위와 같다
    }
  }

  return { tables, images }
}

/** rhwp 의 content-loss 보고서. 지금 쓰는 것은 개수뿐이다. */
interface LossReport {
  count?: number
}

export async function pdfToHwp(
  file: File,
  target: HwpTarget,
  options: PdfHwpOptions = {},
): Promise<PdfHwpResult> {
  const { password, onProgress } = options
  const report = (progress: PdfHwpProgress) => onProgress?.(progress)

  // 엔진(8MB)을 받기 전에 PDF 부터 읽는다. 글자가 없는 스캔본이면 여기서
  // 끝나므로, 쓰지도 않을 파일을 받게 하지 않는다.
  report({ phase: 'reading', ratio: null })
  const layout = await extractPdfLayout(file, {
    password,
    detectTables: true,
    extractImages: true,
    onProgress: (page, pages) => report({ phase: 'reading', ratio: null, page, pages }),
  })

  const items = toItems(layout)
  if (items.length === 0) throw new PdfTextError('NO_TEXT')

  report({ phase: 'engine', ratio: null })
  // 엔진이 도중에 멈추면 새 엔진으로 한 번 더 한다 (rhwp.withEngine).
  return withEngine((ratio) => report({ phase: 'engine', ratio }), (engine: RhwpModule) => {
    report({ phase: 'writing', ratio: null })
    const doc = engine.HwpDocument.createEmpty()

    let bytes: Uint8Array
    let lost = 0
    let pages: number
    let paragraphs: number
    let tables: number
    let images: number

    try {
      const filled = fillDocument(doc, items)
      tables = filled.tables
      images = filled.images
      paragraphs = doc.getParagraphCount(0)
      pages = doc.pageCount()

      const exported =
        target === 'hwp' ? doc.exportHwpWithReport() : doc.exportHwpxWithReport()
      try {
        bytes = exported.takeBytes()
        const parsed = JSON.parse(exported.contentLoss()) as LossReport
        lost = parsed.count ?? 0
      } finally {
        freeDoc(exported)
      }
    } finally {
      // 엔진이 멈춘 뒤에는 해제도 실패한다. 그 실패가 진짜 오류를 가리지 않게 한다.
      freeDoc(doc)
    }

    // 만든 파일을 엔진이 다시 읽어 문단이 그대로인지 본다. 형식이 어긋나면
    // 대개 여기서 먼저 드러난다.
    report({ phase: 'verifying', ratio: null })
    let verified = false
    try {
      const reopened = new engine.HwpDocument(bytes)
      try {
        verified = reopened.getParagraphCount(0) === paragraphs
      } finally {
        freeDoc(reopened)
      }
    } catch {
      verified = false
    }

    return {
      blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: MIME[target] }),
      stats: {
        pages,
        paragraphs,
        tables,
        images,
        emptyPages: layout.emptyPages,
        lost,
        verified,
      },
    }
  })
}
