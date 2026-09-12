/** 이미지 변환. 브라우저 디코더(createImageBitmap)와 캔버스만 쓴다. */
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

export async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('DECODE_FAILED')
  }
}

export async function imageInfo(file: File): Promise<ImageInfo> {
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
): Promise<Blob> {
  const bmp = await decode(file)
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
): Promise<Blob> {
  const bmp = await decode(file)
  try {
    const size = targetSize({ width: bmp.width, height: bmp.height }, spec)
    const canvas = draw(bmp, size.width, size.height, target === 'image/jpeg')
    return await canvasToBlob(canvas, target, quality)
  } finally {
    bmp.close()
  }
}

/**
 * 품질을 낮춰 용량을 줄인다.
 *
 * 결과가 원본보다 커지면 원본을 그대로 돌려준다. 스크린샷처럼 색이 단순한
 * PNG 를 JPEG 로 바꾸면 오히려 커지는 일이 흔한데, "압축"이라는 이름으로
 * 파일을 키워 보내는 것은 거짓말이기 때문이다. 형식이 달라도 마찬가지다.
 */
export async function compressImage(
  file: File,
  target: ImageTarget,
  quality: number,
): Promise<{ blob: Blob; usedOriginal: boolean }> {
  const blob = await convertImage(file, target, quality)
  if (blob.size >= file.size) return { blob: file, usedOriginal: true }
  return { blob, usedOriginal: false }
}
