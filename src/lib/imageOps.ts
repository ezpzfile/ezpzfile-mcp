/**
 * 이미지 변환. 브라우저 디코더(createImageBitmap)와 캔버스만 쓴다.
 *
 * 한 가지 예외가 HEIC 다. 아이폰 기본 형식인데 크롬과 파이어폭스가 못 연다.
 * 브라우저가 거절할 때만 libheif 로 넘기므로, 이 파일을 거쳐 가는 모든
 * 도구가 자동으로 아이폰 사진을 받게 된다(heicOps 참고).
 */
import { decodeHeif, heifDimensions, looksLikeHeif } from './heicOps'
import type { RatioReport } from './fetchProgress'
import { canvasToBlob } from './pdfOps'

export type ImageTarget = 'image/jpeg' | 'image/png' | 'image/webp'

export const TARGET_EXT: Record<ImageTarget, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export interface ImageInfo {
  width: number
  height: number
}

/**
 * report 는 HEIC 디코더(1.4MB)를 받는 동안에만 불린다. 사파리처럼 브라우저가
 * 스스로 HEIC 를 여는 곳에서는 한 번도 불리지 않는다.
 */
export async function decode(file: File, report: RatioReport = () => {}): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    // 여기까지 왔다는 것은 브라우저가 이 형식을 모른다는 뜻이다. HEIC 면
    // 우리가 풀 수 있다.
    if (await looksLikeHeif(file)) return decodeHeif(file, report)
    throw new Error('DECODE_FAILED')
  }
}

export async function imageInfo(file: File): Promise<ImageInfo> {
  // HEIC 는 크기가 머리쪽에 적혀 있다. 놓기만 한 파일 때문에 디코더를 받지
  // 않으려고 그쪽을 먼저 본다.
  if (await looksLikeHeif(file)) {
    const size = await heifDimensions(file)
    if (size) return size
  }
  const bmp = await decode(file)
  const info = { width: bmp.width, height: bmp.height }
  bmp.close()
  return info
}

function draw(bmp: ImageBitmap, w: number, h: number, opaque: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('CANVAS_UNAVAILABLE')
  // JPEG 에는 알파가 없다. 흰 배경을 깔지 않으면 투명한 부분이 검게 나온다.
  if (opaque) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** 형식만 바꾼다 (크기 유지). */
export async function convertImage(
  file: File,
  target: ImageTarget,
  quality: number,
  report: RatioReport = () => {},
): Promise<Blob> {
  const bmp = await decode(file, report)
  try {
    const canvas = draw(bmp, bmp.width, bmp.height, target === 'image/jpeg')
    return await canvasToBlob(canvas, target, quality)
  } finally {
    bmp.close()
  }
}

export interface ResizeSpec {
  mode: 'width' | 'height' | 'percent' | 'longest'
  value: number
  /** 원본보다 크게 만들지 않는다 */
  noUpscale: boolean
}

export function targetSize(info: ImageInfo, spec: ResizeSpec) {
  const ratio = info.height / info.width
  let w: number
  let h: number
  switch (spec.mode) {
    case 'width':
      w = spec.value
      h = w * ratio
      break
    case 'height':
      h = spec.value
      w = h / ratio
      break
    case 'longest': {
      const scale = spec.value / Math.max(info.width, info.height)
      w = info.width * scale
      h = info.height * scale
      break
    }
    default:
      w = (info.width * spec.value) / 100
      h = (info.height * spec.value) / 100
  }
  if (spec.noUpscale && w > info.width) {
    w = info.width
    h = info.height
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) }
}

export async function resizeImage(
  file: File,
  spec: ResizeSpec,
  target: ImageTarget,
  quality: number,
  report: RatioReport = () => {},
): Promise<Blob> {
  const bmp = await decode(file, report)
  try {
    const size = targetSize({ width: bmp.width, height: bmp.height }, spec)
    const canvas = draw(bmp, size.width, size.height, target === 'image/jpeg')
    return await canvasToBlob(canvas, target, quality)
  } finally {
    bmp.close()
  }
}

/** 원본이 이미 그 형식인가(jpg·jpeg 는 같다) */
function sameFormat(file: File, target: ImageTarget): boolean {
  const t = (file.type || '').toLowerCase()
  if (t) return t === target || (target === 'image/jpeg' && t === 'image/jpg')
  const e = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TARGET_EXT[target] === e || (target === 'image/jpeg' && (e === 'jpg' || e === 'jpeg'))
}

/**
 * 품질을 낮춰 용량을 줄인다.
 *
 * 결과가 원본보다 커지면 원본을 그대로 돌려준다. 스크린샷처럼 색이 단순한
 * PNG 를 JPEG 로 바꾸면 오히려 커지는 일이 흔한데, "압축"이라는 이름으로
 * 파일을 키워 보내는 것은 거짓말이기 때문이다. 다만 사람이 출력 형식을 직접 골라 바꿨으면
 * 커져도 고른 형식으로 준다(chosenFormat).
 */
export async function compressImage(
  file: File,
  target: ImageTarget,
  quality: number,
  report: RatioReport = () => {},
  /** 사용자가 출력 형식을 직접 골랐다. 원본과 형식이 다르면 커져도 고른 형식으로 준다(2026-10-31 제보: JPG→PNG 가 늘 원본 JPG 로 돌아옴) */
  chosenFormat = false,
): Promise<{ blob: Blob; usedOriginal: boolean; grew?: boolean }> {
  const blob = await convertImage(file, target, quality, report)
  if (chosenFormat && !sameFormat(file, target)) return { blob, usedOriginal: false, grew: blob.size > file.size }
  // HEIC 는 워낙 효율이 좋아 JPEG 로 바꾸면 대개 커진다. 그렇다고 원본을
  // 돌려주면 열지도 못하는 파일을 그대로 돌려받는 셈이라, 여기서는 커지더라도
  // 바꾼 것을 준다.
  if (blob.size >= file.size && !(await looksLikeHeif(file))) {
    return { blob: file, usedOriginal: true }
  }
  return { blob, usedOriginal: false }
}
