/**
 * QR 코드 생성.
 *
 * 인코딩은 qrcode-generator(의존성 없는 순수 구현)에 맡기고, 그리는 일은
 * 여기서 직접 한다. 라이브러리가 주는 createSvgTag / createDataURL 은
 * 색과 여백을 우리 마음대로 못 주기 때문이다.
 *
 * 다른 도구와 마찬가지로 네트워크를 타지 않는다. 입력한 문자열이 밖으로 나가지 않는다.
 */

/** 오류 정정 수준. 높을수록 더러워져도 읽히지만 담을 수 있는 글자가 준다. */
export type QrLevel = 'L' | 'M' | 'Q' | 'H'

export interface QrOptions {
  text: string
  level?: QrLevel
  /** 결과 PNG 한 변의 픽셀 */
  size?: number
  /** 조용한 구역(테두리 여백)을 모듈 몇 칸으로 둘지. 규격 권장값은 4 */
  margin?: number
  dark?: string
  light?: string
}

export interface QrMatrix {
  /** 한 변의 모듈 수 (여백 제외) */
  count: number
  /** [row][col], true 면 검은 칸 */
  cells: boolean[][]
}

const DEFAULTS = {
  level: 'M' as QrLevel,
  size: 512,
  margin: 4,
  dark: '#000000',
  light: '#ffffff',
}

/**
 * 문자열을 QR 격자로 만든다.
 * typeNumber 0 은 "글자 수에 맞는 최소 버전을 알아서 고르라"는 뜻이다.
 */
export async function buildMatrix(text: string, level: QrLevel = 'M'): Promise<QrMatrix> {
  const { default: qrcode } = await import('qrcode-generator')
  const qr = qrcode(0, level)
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const cells: boolean[][] = []
  for (let r = 0; r < count; r++) {
    const row: boolean[] = []
    for (let c = 0; c < count; c++) row.push(qr.isDark(r, c))
    cells.push(row)
  }
  return { count, cells }
}

/** 화면 미리보기와 SVG 내려받기에 함께 쓰는 벡터 출력. */
export function toSvg(matrix: QrMatrix, opts: Omit<QrOptions, 'text' | 'level'> = {}): string {
  const { size, margin, dark, light } = { ...DEFAULTS, ...opts }
  const total = matrix.count + margin * 2

  // 검은 칸을 path 하나로 합친다. <rect> 를 수천 개 뿌리면 파일이 무거워진다.
  let d = ''
  for (let r = 0; r < matrix.count; r++) {
    for (let c = 0; c < matrix.count; c++) {
      if (matrix.cells[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`
  )
}

/**
 * PNG 로 굽는다. SVG 를 이미지로 태워 캔버스에 그린다.
 * 모듈 경계가 반픽셀에 걸리면 흐려지므로, 실제 캔버스 크기는
 * 모듈 수의 배수로 맞춘 뒤 요청한 크기로 줄인다.
 */
export async function toPngBlob(
  matrix: QrMatrix,
  opts: Omit<QrOptions, 'text' | 'level'> = {},
): Promise<Blob> {
  const { size, margin, dark, light } = { ...DEFAULTS, ...opts }
  const total = matrix.count + margin * 2
  const scale = Math.max(1, Math.round(size / total))
  const px = total * scale

  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('CANVAS_UNAVAILABLE')

  ctx.fillStyle = light
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = dark
  for (let r = 0; r < matrix.count; r++) {
    for (let c = 0; c < matrix.count; c++) {
      if (matrix.cells[r][c]) {
        ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale)
      }
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('ENCODE_FAILED'))),
      'image/png',
    )
  })
}

export function svgToBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
}

/** 파일 이름에 쓸 수 있게 다듬는다. 주소를 넣는 경우가 가장 흔하다. */
export function suggestName(text: string): string {
  const trimmed = text.trim()
  try {
    const url = new URL(trimmed)
    return url.hostname.replace(/^www\./, '') || 'qr'
  } catch {
    /* 주소가 아니면 아래로 */
  }
  const cleaned = trimmed
    .slice(0, 40)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'qr'
}
