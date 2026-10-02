/**
 * PDF 에서 문단과 표를 되살린다.
 *
 * PDF 는 글을 담는 형식이 아니라 쪽을 그리는 형식이다. 안에 있는 것은 문단이
 * 아니라 "이 자리에 이 글자를 찍어라" 뿐이고, 어디서 문단이 끊기는지, 어디가
 * 표인지는 아무 데도 적혀 있지 않다. 그래서 되돌리는 일은 복원이지 변환이
 * 아니다. 여기서 하는 것은 좌표를 보고 원래 모양을 추측하는 것이다.
 *
 * 추측이므로 틀릴 수 있다. 화면에서 그렇게 말해야 한다. 이 파일은 확신할 수
 * 없는 값을 지어내지 않고, 글자가 아예 없는 쪽은 번호를 그대로 돌려준다.
 * 스캔한 PDF 는 그림이라 글자가 없고, 우리는 글자 인식을 하지 않는다.
 */
import { PDFJS_ASSETS, getPdfjs } from './pdfOps'
import { pdfImageToPng, type PdfImage } from './pdfImagePng'

/** 한 줄을 이루는 글자 조각. */
interface Piece {
  text: string
  /** 왼쪽 끝 (화면 좌표, 오른쪽으로 증가) */
  x: number
  /** 글줄 밑선 (화면 좌표, 아래로 증가) */
  y: number
  width: number
  size: number
}

export interface LayoutLine {
  text: string
  x0: number
  x1: number
  y: number
  size: number
  /** 칸으로 나눌 수 있는 조각. 표를 찾을 때 쓴다. */
  cells: Array<{ text: string; x0: number; x1: number }>
}

export interface ParagraphBlock {
  kind: 'paragraph'
  text: string
  /** 본문보다 눈에 띄게 큰 글씨였는가 */
  heading: boolean
}

export interface TableBlock {
  kind: 'table'
  rows: string[][]
}

/**
 * 줄의 칸을 열에 떨어뜨린다.
 *
 * 줄마다 칸 수가 다를 수 있다. 값이 빈 칸은 애초에 글자가 없어 조각도 없기
 * 때문이다. 그대로 이어 붙이면 한 칸씩 밀려 표가 어긋나므로, 각 칸을 가장
 * 가까운 열에 놓고 나머지는 빈 칸으로 둔다.
 */
function snapToColumns(line: LayoutLine, columns: number[]): string[] {
  const row = new Array<string>(columns.length).fill('')
  for (const cell of line.cells) {
    let best = 0
    let bestDistance = Infinity
    for (const [i, x] of columns.entries()) {
      const distance = Math.abs(cell.x0 - x)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    row[best] = row[best] ? `${row[best]} ${cell.text}` : cell.text
  }
  return row
}

/**
 * 쪽에 찍혀 있던 그림. 도장과 서명이 대부분 여기로 들어온다.
 *
 * PNG 바이트로 통일한다. 원본이 JPEG 든 무엇이든 pdfjs 는 이미 디코딩해서
 * 넘겨 주므로, 다시 인코딩하지 않고 원본 바이트를 꺼낼 길이 없다. 그럴 바에는
 * 손실 없는 쪽으로 한 번만 굽는다.
 */
export interface ImageBlock {
  kind: 'image'
  bytes: Uint8Array
  /** 쪽에 찍혀 있던 크기(pt). 문서에 넣을 때 이 비율을 쓴다. */
  width: number
  height: number
  /** 원본 화소 크기 */
  naturalWidth: number
  naturalHeight: number
}

export type LayoutBlock = ParagraphBlock | TableBlock | ImageBlock

export interface PageLayout {
  /** 1부터 센 쪽 번호 */
  page: number
  blocks: LayoutBlock[]
  lines: LayoutLine[]
}

export interface PdfLayout {
  pages: PageLayout[]
  /** 글자가 하나도 없던 쪽 번호. 대개 스캔한 쪽이다. */
  emptyPages: number[]
  pageCount: number
  /** 찾아낸 표의 수 */
  tableCount: number
  /** 꺼낸 그림의 수 */
  imageCount: number
  /** 그림을 꺼내다 실패한 쪽이 있었나. 글은 멀쩡하고 그림만 빠진 상태다. */
  imagesDropped: boolean
}

export class PdfTextError extends Error {
  constructor(readonly reason: 'ENCRYPTED' | 'UNREADABLE' | 'NO_TEXT') {
    super(reason)
  }
}

export interface LayoutOptions {
  password?: string
  /** 표를 찾을지. 워드·한글은 문단만 쓰고 엑셀은 표가 목적이다. */
  detectTables?: boolean
  /** 그림을 꺼낼지. 엑셀은 그림을 담을 수 없어 끈다. */
  extractImages?: boolean
  onProgress?: (page: number, pages: number) => void
}

/* ------------------------------------------------------------------ 도구 */

/** 화면 좌표로 옮긴다. 쪽이 돌아가 있어도 읽는 순서가 유지된다. */
function apply(m: number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/* ------------------------------------------------------------------- 줄 */

/**
 * 조각을 글줄로 묶는다.
 *
 * 같은 줄인지는 밑선의 y 로 본다. 글자 크기의 절반을 넘게 어긋나면 다른 줄로
 * 본다. 고정값을 쓰지 않는 이유는 제목과 본문이 한 쪽에 같이 있기 때문이다.
 */
function toLines(pieces: Piece[]): LayoutLine[] {
  if (pieces.length === 0) return []
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x - b.x)

  const groups: Piece[][] = []
  let current: Piece[] = [sorted[0]!]
  for (const piece of sorted.slice(1)) {
    const last = current[current.length - 1]!
    const tolerance = Math.max(2, Math.min(last.size, piece.size) * 0.5)
    if (Math.abs(piece.y - last.y) <= tolerance) current.push(piece)
    else {
      groups.push(current)
      current = [piece]
    }
  }
  groups.push(current)

  return groups.map((group) => {
    const row = [...group].sort((a, b) => a.x - b.x)
    const size = median(row.map((p) => p.size))

    // 조각 사이가 벌어져 있으면 칸이 나뉜 것으로 본다. 낱말 사이 공백보다
    // 훨씬 넓어야 하므로 글자 크기를 기준으로 잡는다.
    const cells: LayoutLine['cells'] = []
    let text = ''
    let cellText = ''
    let cellX0 = row[0]!.x
    let cellX1 = row[0]!.x

    for (const [i, piece] of row.entries()) {
      if (i > 0) {
        const prev = row[i - 1]!
        const gap = piece.x - (prev.x + prev.width)
        const wide = gap > size * 1.4
        const spaced = gap > size * 0.18
        if (wide) {
          cells.push({ text: cellText.trim(), x0: cellX0, x1: cellX1 })
          cellText = ''
          cellX0 = piece.x
          text += '\t'
        } else if (spaced && !/\s$/.test(text) && !/^\s/.test(piece.text)) {
          cellText += ' '
          text += ' '
        }
      }
      cellText += piece.text
      text += piece.text
      cellX1 = piece.x + piece.width
    }
    cells.push({ text: cellText.trim(), x0: cellX0, x1: cellX1 })

    return {
      text: text.replace(/\s+$/, ''),
      x0: row[0]!.x,
      x1: cellX1,
      y: median(row.map((p) => p.y)),
      size,
      cells: cells.filter((c) => c.text.length > 0),
    }
  })
}

/* ------------------------------------------------------------------- 표 */

/**
 * 줄 맞춰 놓인 값을 표로 본다.
 *
 * 선을 보지 않고 자리만 본다. PDF 의 표는 선이 없는 경우가 흔하고, 있더라도
 * 선은 글자와 다른 층에 그려져 있어 글 추출로는 잡히지 않는다. 대신 여러 줄에
 * 걸쳐 칸의 왼쪽 끝이 같은 자리에 서 있으면 표라고 본다.
 *
 * 세 줄 이상이어야 표로 인정한다. 두 줄짜리는 그냥 제목과 날짜가 양끝에 붙어
 * 있는 머리글인 경우가 많아, 표로 만들면 오히려 읽기 어려워진다.
 */
function findTables(lines: LayoutLine[]): Array<{ from: number; to: number; columns: number[] }> {
  const found: Array<{ from: number; to: number; columns: number[] }> = []
  let start = -1
  let columns: number[] = []

  const sameColumns = (a: number[], b: number[]) => {
    if (a.length !== b.length) return false
    // 칸 하나 너비쯤 어긋나는 것은 가운데 맞춤이라 같은 표로 본다.
    return a.every((x, i) => Math.abs(x - b[i]!) < 24)
  }

  const flush = (end: number) => {
    if (start >= 0 && end - start >= 2) found.push({ from: start, to: end, columns })
    start = -1
    columns = []
  }

  for (const [i, line] of lines.entries()) {
    const xs = line.cells.map((c) => c.x0)
    if (xs.length < 2) {
      flush(i - 1)
      continue
    }
    if (start < 0) {
      start = i
      columns = xs
      continue
    }
    if (sameColumns(columns, xs)) continue
    flush(i - 1)
    start = i
    columns = xs
  }
  flush(lines.length - 1)

  return found
}


/* ---------------------------------------------------------------- 그림 */

/** 두 변환 행렬을 곱한다. */
function multiply(a: number[], b: number[]): number[] {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ]
}

/** 너무 작은 그림은 장식용 선이고, 쪽을 통째로 덮은 그림은 배경 스캔이다. */
const MIN_SIDE = 12
const MAX_COVERAGE = 0.9

/**
 * 쪽에 찍힌 그림을 자리와 함께 꺼낸다.
 *
 * 그림이 놓인 자리는 명령 목록을 따라가야 알 수 있다. 그림을 그리라는 명령
 * 자체에는 좌표가 없고, 그 시점의 변환 행렬이 단위 사각형을 실제 자리로 옮긴다.
 * 그래서 save·restore·transform 을 그대로 따라가며 행렬을 들고 다닌다.
 */
/** collectImages 가 쓰는 만큼만 추린 쪽 객체. pdfjs 타입을 통째로 끌고 오지 않는다. */
interface ImagePage {
  getViewport: (o: { scale: number }) => { transform: number[]; width: number; height: number }
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  objs: { get: (id: string, cb: (value: unknown) => void) => void }
  commonObjs: { get: (id: string, cb: (value: unknown) => void) => void }
}

async function collectImages(
  pdfjs: Awaited<ReturnType<typeof getPdfjs>>,
  page: ImagePage,
): Promise<Array<{ y: number; block: ImageBlock }>> {
  const viewport = page.getViewport({ scale: 1 })
  const pageArea = viewport.width * viewport.height
  const ops = await page.getOperatorList()

  const placed: Array<{ id: string | null; inline: PdfImage | null; ctm: number[] }> = []
  const stack: number[][] = []
  let ctm = viewport.transform.slice()

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i] as unknown[]
    if (fn === pdfjs.OPS.save) stack.push(ctm.slice())
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, args as number[])
    else if (fn === pdfjs.OPS.paintImageXObject) {
      placed.push({ id: String(args[0]), inline: null, ctm: ctm.slice() })
    } else if (fn === pdfjs.OPS.paintInlineImageXObject) {
      placed.push({ id: null, inline: args[0] as PdfImage, ctm: ctm.slice() })
    }
  }

  const out: Array<{ y: number; block: ImageBlock }> = []
  for (const entry of placed) {
    const [a, b, c, d, , f] = entry.ctm
    const width = Math.hypot(a!, b!)
    const height = Math.hypot(c!, d!)
    if (width < MIN_SIDE || height < MIN_SIDE) continue
    if (pageArea > 0 && (width * height) / pageArea > MAX_COVERAGE) continue

    let image = entry.inline
    if (!image && entry.id) {
      const holder = entry.id.startsWith('g_') ? page.commonObjs : page.objs
      image = await new Promise<PdfImage | null>((resolve) => {
        try {
          holder.get(entry.id!, (value) => resolve((value as PdfImage) ?? null))
        } catch {
          resolve(null)
        }
      })
    }
    if (!image) continue

    const bytes = await pdfImageToPng(image)
    if (!bytes) continue

    out.push({
      // 변환 행렬의 f 는 그림 아래쪽이다. 글줄과 견주려면 위쪽으로 맞춘다.
      y: f! - height,
      block: {
        kind: 'image',
        bytes,
        width,
        height,
        naturalWidth: image.width,
        naturalHeight: image.height,
      },
    })
  }

  return out
}

/* --------------------------------------------------------------- 문단 */

/**
 * 줄을 문단으로 묶는다.
 *
 * 줄 사이가 평소보다 벌어졌거나, 앞 줄이 오른쪽 끝까지 가지 못하고 끝났으면
 * 거기서 문단이 끊긴 것으로 본다. 뒤의 규칙이 중요하다. 줄 간격만 보면 두
 * 문단이 바짝 붙어 있을 때 하나로 이어져 버린다.
 */
function toParagraphs(
  lines: LayoutLine[],
  bodySize: number,
): Array<{ y: number; block: ParagraphBlock }> {
  if (lines.length === 0) return []

  const gaps: number[] = []
  for (let i = 1; i < lines.length; i += 1) gaps.push(lines[i]!.y - lines[i - 1]!.y)
  const normalGap = median(gaps.filter((g) => g > 0)) || bodySize * 1.2
  const rightEdge = Math.max(...lines.map((l) => l.x1))

  const blocks: Array<{ y: number; block: ParagraphBlock }> = []
  let buffer: LayoutLine[] = [lines[0]!]

  const flush = () => {
    if (buffer.length === 0) return
    const size = median(buffer.map((l) => l.size))
    const text = buffer
      .map((l) => l.text.replace(/\t/g, ' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) {
      blocks.push({
        y: buffer[0]!.y,
        block: {
          kind: 'paragraph',
          text,
          // 한 줄뿐이고 본문보다 확실히 큰 글씨면 제목으로 본다.
          heading: buffer.length === 1 && size > bodySize * 1.25,
        },
      })
    }
    buffer = []
  }

  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1]!
    const line = lines[i]!
    const gap = line.y - prev.y
    const looseGap = gap > normalGap * 1.45
    // 앞 줄이 오른쪽 끝에서 한참 못 미치게 끝났다면 문단이 거기서 닫힌 것이다.
    const endedShort = prev.x1 < rightEdge - prev.size * 2.5
    const sizeChanged = Math.abs(line.size - prev.size) > bodySize * 0.2

    if (looseGap || endedShort || sizeChanged) flush()
    buffer.push(line)
  }
  flush()

  return blocks
}

/* ------------------------------------------------------------------ 공개 */

export async function extractPdfLayout(
  file: File,
  options: LayoutOptions = {},
): Promise<PdfLayout> {
  const { password, detectTables = false, extractImages = false, onProgress } = options
  /** 그림을 못 담은 쪽이 있었나. 결과가 반쪽이라는 것을 부르는 쪽이 알아야 한다. */
  let imagesDropped = false
  const pdfjs = await getPdfjs()

  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    ...PDFJS_ASSETS,
    password,
    // 경고를 console.log 로 찍는다. 끄지 않으면 콘솔이 지저분해진다.
    verbosity: 0,
  })

  let doc
  try {
    doc = await task.promise
  } catch (err) {
    const name = String((err as { name?: string })?.name ?? '')
    await task.destroy().catch(() => {})
    if (name === 'PasswordException') throw new PdfTextError('ENCRYPTED')
    throw new PdfTextError('UNREADABLE')
  }

  const pages: PageLayout[] = []
  const emptyPages: number[] = []
  let tableCount = 0
  let imageCount = 0

  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      onProgress?.(n, doc.numPages)
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()

      const pieces: Piece[] = []
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue
        const transform = item.transform as number[]
        const size = Math.abs(transform[3]!) || Math.abs(transform[1]!) || 10
        const [x, y] = apply(viewport.transform as number[], transform[4]!, transform[5]!)
        if (!item.str.trim()) continue
        pieces.push({ text: item.str, x, y, width: item.width ?? 0, size })
      }

      const lines = toLines(pieces)
      if (lines.length === 0) {
        emptyPages.push(n)
        pages.push({ page: n, blocks: [], lines: [] })
        continue
      }

      const bodySize = median(lines.map((l) => l.size)) || 10
      // 글과 그림을 한 줄에 세워 두고 마지막에 y 로 정렬한다. 그림이 원래
      // 있던 자리(문단 사이)에 그대로 들어가려면 순서를 따로 세워야 한다.
      const entries: Array<{ y: number; block: LayoutBlock }> = []

      if (detectTables) {
        const tables = findTables(lines)
        tableCount += tables.length
        let cursor = 0
        for (const table of tables) {
          if (table.from > cursor) {
            entries.push(...toParagraphs(lines.slice(cursor, table.from), bodySize))
          }
          entries.push({
            y: lines[table.from]!.y,
            block: {
              kind: 'table',
              rows: lines
                .slice(table.from, table.to + 1)
                .map((line) => snapToColumns(line, table.columns)),
            },
          })
          cursor = table.to + 1
        }
        if (cursor < lines.length) entries.push(...toParagraphs(lines.slice(cursor), bodySize))
      } else {
        entries.push(...toParagraphs(lines, bodySize))
      }

      if (extractImages) {
        /*
         * 그림은 **덤이다.** 글은 다 뽑았는데 그림 하나 때문에 변환 전체가
         * 무너지면 안 된다. 실제로 그런 일이 있었다 — pdf.js 가 브라우저에
         * 아직 없는 메서드를 부르는 바람에 여기서 TypeError 가 났고,
         * 글이 멀쩡히 읽힌 문서까지 통째로 실패했다 (2026-09).
         * 그림이 빠진 결과는 아쉬운 결과지만, 아무것도 못 받는 것보다 낫다.
         */
        try {
          const images = await collectImages(pdfjs, page as unknown as ImagePage)
          imageCount += images.length
          entries.push(...images)
        } catch {
          imagesDropped = true
        }
      }

      entries.sort((a, b) => a.y - b.y)
      page.cleanup()
      pages.push({ page: n, blocks: entries.map((e) => e.block), lines })
    }
  } finally {
    await task.destroy().catch(() => {})
  }

  if (emptyPages.length === doc.numPages) throw new PdfTextError('NO_TEXT')

  return { pages, emptyPages, pageCount: doc.numPages, tableCount, imageCount, imagesDropped }
}
