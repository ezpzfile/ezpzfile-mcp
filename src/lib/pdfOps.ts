/**
 * PDF 조작. 전부 브라우저에서 실행되며 서버로 나가는 요청이 없다.
 * pdf-lib / pdf.js 는 호출 시점에 동적 import 한다 (프리렌더는 Node에서 돈다).
 */

export interface OutputFile {
  name: string
  blob: Blob
  /** 결과 목록에 함께 보여줄 한 줄 (예: "3쪽 · 210 KB") */
  note?: string
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

/** pdf.js 를 브라우저에서만 불러온다. 워커는 번들에서 함께 나온다. */
export async function getPdfjs() {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

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
