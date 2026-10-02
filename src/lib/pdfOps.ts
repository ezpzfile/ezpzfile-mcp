/**
 * PDF 조작. 전부 브라우저에서 실행되며 서버로 나가는 요청이 없다.
 * pdf-lib / pdf.js 는 호출 시점에 동적 import 한다 (프리렌더는 Node에서 돈다).
 */

import { ensureStreamIteration } from './streamIter'

export interface OutputFile {
  name: string
  blob: Blob
  /** 결과 목록에 함께 보여줄 한 줄 (예: "3쪽 · 210 KB") */
  note?: string
  /** 전후 비교용 원본. 결과 페이지가 "원본과 비교" 를 띄울 때만 넘긴다. */
  source?: Blob
  /** 결과를 여는 데 필요한 암호(PDF 암호 걸기). 미리보기만 쓴다. */
  password?: string
}

export async function loadPdf(file: File) {
  const { PDFDocument } = await import('pdf-lib')
  return PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })
}

/** 원본에서 지정한 페이지만 복사해 새 문서를 만든다. */
export async function pickPages(file: File, indices: number[]) {
  const { PDFDocument } = await import('pdf-lib')
  const src = await loadPdf(file)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, indices)
  copied.forEach((p) => out.addPage(p))
  return out
}

export async function toPdfBlob(doc: {
  save: () => Promise<Uint8Array>
}): Promise<Blob> {
  const bytes = await doc.save()
  return new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: 'application/pdf',
  })
}

/** 페이지 회전. angles 는 페이지 인덱스 → 추가 회전각(90의 배수). */
export async function rotatePages(
  file: File,
  angles: Map<number, number>,
): Promise<Blob> {
  const { degrees } = await import('pdf-lib')
  const doc = await loadPdf(file)
  doc.getPages().forEach((page, i) => {
    const delta = angles.get(i) ?? 0
    if (delta === 0) return
    const next = (((page.getRotation().angle + delta) % 360) + 360) % 360
    page.setRotation(degrees(next))
  })
  return toPdfBlob(doc)
}

/** 지정한 페이지를 뺀 나머지로 새 문서를 만든다. */
export async function deletePages(file: File, remove: Set<number>): Promise<Blob> {
  const src = await loadPdf(file)
  const keep = src
    .getPageIndices()
    .filter((i) => !remove.has(i))
  if (keep.length === 0) throw new Error('EMPTY_RESULT')
  return toPdfBlob(await pickPages(file, keep))
}

/** 새 순서대로 페이지를 재배치한다. order 는 원본 인덱스 배열. */
export async function reorderPages(file: File, order: number[]): Promise<Blob> {
  return toPdfBlob(await pickPages(file, order))
}

/** 이미지들을 한 권의 PDF로 묶는다. */
export async function imagesToPdf(
  files: File[],
  opts: { pageSize: 'fit' | 'a4'; margin: number },
): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const out = await PDFDocument.create()
  const A4 = { w: 595.28, h: 841.89 }

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const isPng =
      file.type === 'image/png' || /\.png$/i.test(file.name) || isPngBytes(bytes)
    const image = isPng
      ? await out.embedPng(bytes)
      : await out.embedJpg(bytes)

    if (opts.pageSize === 'fit') {
      const page = out.addPage([image.width, image.height])
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
    } else {
      const page = out.addPage([A4.w, A4.h])
      const m = opts.margin
      const maxW = A4.w - m * 2
      const maxH = A4.h - m * 2
      const scale = Math.min(maxW / image.width, maxH / image.height, 1)
      const w = image.width * scale
      const h = image.height * scale
      page.drawImage(image, {
        x: (A4.w - w) / 2,
        y: (A4.h - h) / 2,
        width: w,
        height: h,
      })
    }
  }
  return toPdfBlob(out)
}

function isPngBytes(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}

/**
 * pdf.js 를 브라우저에서만 불러온다. 워커는 번들에서 함께 나온다.
 *
 * **legacy 판을 쓴다.** 기본 판은 `Map.prototype.getOrInsertComputed` 를
 * 그냥 있다고 치고 부른다. 이건 2026년에야 들어간 아주 새 메서드다 —
 * 크롬·엣지 145, 파이어폭스 144, 사파리 26.2 부터고, 삼성 인터넷에는
 * 아직 없다. 없는 브라우저에서는 문서를 여는 첫걸음부터
 * `getOrInsertComputed is not a function` 으로 죽는다. PDF→JPG, PDF→PNG,
 * 쪽 미리보기, PDF→한글 이 한꺼번에 무너지는 자리다.
 * (2026-09-22 확인. 전 세계 브라우저의 약 18% 가 여기 걸린다.
 *  한국은 삼성 인터넷 비중이 높아 더 나쁘다.)
 *
 * legacy 판은 core-js 폴리필을 본체와 워커 **양쪽에** 넣어 둔 판이다.
 * 폴리필 값은 압축 기준 본체 +20KB, 워커 +17KB. 그런데 이참에 워커를
 * 압축본으로 바꿨더니 워커가 오히려 477KB → 392KB 로 줄었다. 게다가 이
 * 덩어리는 PDF 도구를 실제로 쓸 때만 받아 간다 — 첫 화면과는 상관이 없다.
 *
 * 폴리필을 우리가 직접 넣는 길도 있지만, 워커는 다른 실행 환경이라
 * 워커 파일 안에도 따로 넣어야 한다. 그러자고 워커 진입점을 손수 만들면
 * 번들러 설정에 매달리는 약한 고리가 하나 늘고, 그래 봐야 pdf.js 가
 * 앞으로 쓸 다른 새 문법은 못 막는다.
 */
export async function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  // 사파리에 없는 것을 먼저 채운다. pdf.js 가 글자를 뽑을 때 바로 쓴다.
  ensureStreamIteration()
  // 타입 선언은 기본 빌드 경로에만 붙어 있다. 내보내는 것은 똑같으므로 그 타입으로 본다.
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  // ?url 은 파일을 그대로 복사해 내보낸다. 압축본을 집어야 400KB 를 아낀다.
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/**
 * pdf.js 가 필요할 때 받아 가는 곁들이 파일. scripts/sync-pdfjs-assets.mjs 가
 * public/pdfjs/ 로 옮겨 둔다.
 *
 * standardFontDataUrl 이 없으면 글꼴이 안 심긴 PDF(기본 14종 이름만 적힌
 * 문서)를 아무 글꼴로나 그린다. 글자 너비가 원본과 달라져서, 보기만 할 때도
 * 줄이 어긋나고 원본 글자를 제자리에서 고칠 때는 덮을 자리가 빗나간다.
 *
 * cMapUrl 은 한중일 문서가 쓰는 미리 정해진 인코딩 표다. 한국어 문서를
 * 다루는 사이트에 없으면 글자가 통째로 깨진다.
 *
 * 둘 다 필요한 파일만 그때 받아 가므로 첫 화면 무게와는 상관이 없다.
 */
export const PDFJS_ASSETS = {
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
} as const

export interface RenderedPage {
  index: number
  canvas: HTMLCanvasElement
}

/**
 * 각 페이지를 캔버스로 그린다. scale 은 72dpi 기준 배율(2 ≈ 144dpi).
 * onPage 로 한 장씩 넘겨 메모리를 붙들지 않게 한다.
 */
export async function renderPdfPages(
  file: File,
  opts: { scale: number; indices?: number[] },
  onPage: (page: RenderedPage) => Promise<void> | void,
): Promise<number> {
  const pdfjs = await getPdfjs()
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    ...PDFJS_ASSETS,
  })
  const doc = await task.promise
  const list = opts.indices ?? Array.from({ length: doc.numPages }, (_, i) => i)

  for (const index of list) {
    const page = await doc.getPage(index + 1)
    const viewport = page.getViewport({ scale: opts.scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('CANVAS_UNAVAILABLE')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    await onPage({ index, canvas })
    page.cleanup()
  }
  // 워커까지 정리해야 여러 번 실행해도 메모리가 쌓이지 않는다.
  await task.destroy()
  return list.length
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('ENCODE_FAILED'))),
      type,
      quality,
    )
  })
}
