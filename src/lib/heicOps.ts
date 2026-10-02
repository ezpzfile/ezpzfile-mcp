/**
 * 아이폰 기본 사진 형식(HEIC)을 브라우저 안에서 푼다.
 *
 * 크롬과 파이어폭스는 HEIC 를 아예 디코딩하지 못한다. 사파리는 된다. 그래서
 * 브라우저에게 먼저 맡겨 보고, 못 한다고 할 때만 libheif 를 받는다. 아이폰에서
 * 여는 사람은 1.4MB 를 받을 일이 없다.
 *
 * 회전: HEIC 는 돌려 찍은 사진을 픽셀째 돌려 담지 않는다. "이만큼 돌려서
 * 보여라" 라는 표시(irot)만 붙여 둔다. 그 표시를 무시하고 그리면 사진이 눕는다.
 * libheif 는 표시를 읽어 적용한 것을 내주므로 여기서 따로 돌리지 않는다.
 * irot 값 1·2·3 을 넣은 파일로 확인했다.
 *
 * 라이선스: libheif 는 LGPL-3.0 이다. 번들에 녹이지 않고 public/vendor 에
 * 버전 폴더째 두어 갈아끼울 수 있게 한다. 이것이 LGPL 이 요구하는 교체
 * 가능성이다. 전문은 public/vendor/libheif/1.23.2/LICENSE 에 함께 배포한다.
 */
import { fetchWithProgress, type RatioReport } from '#/lib/fetchProgress'

/** 버전을 폴더로 고정한다. 올릴 때는 폴더를 새로 만들고 이 값을 바꾼다. */
const BASE = '/vendor/libheif/1.23.2/'

/** libheif 가 내주는 사진 한 장. 쓰는 것만 적었다. */
interface HeifImage {
  get_width(): number
  get_height(): number
  display(into: ImageData, done: (result: ImageData | null) => void): void
  free?(): void
}

interface LibheifModule {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] }
}

type LibheifFactory = (options: { wasmBinary: ArrayBuffer }) => Promise<LibheifModule>

let modulePromise: Promise<LibheifModule> | null = null

/** UMD 빌드라 import() 가 아니라 script 태그로 들여온다. 전역에 libheif 를 놓는다. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('HEIC_ENGINE_FAILED')))
      if ((window as { libheif?: unknown }).libheif) resolve()
      return
    }
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => reject(new Error('HEIC_ENGINE_FAILED'))
    document.head.appendChild(el)
  })
}

/**
 * 디코더를 띄운다. 두 번째 호출부터는 받아 둔 것을 그대로 돌려주므로 report 가
 * 한 번도 불리지 않는다. 호출부는 그래도 되도록 써야 한다.
 *
 * wasm 을 직접 받아 넘기는 이유는 이 빌드가 스스로 받으려다 실패하기 때문이다.
 * 어차피 1.4MB 라 진행률을 보여 주어야 해서 받는 편이 낫다.
 */
async function loadDecoder(report: RatioReport): Promise<LibheifModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [, wasmBinary] = await Promise.all([
        loadScript(`${BASE}libheif.js`),
        fetchWithProgress(`${BASE}libheif.wasm`, report),
      ])
      const factory = (window as { libheif?: LibheifFactory }).libheif
      if (!factory) throw new Error('HEIC_ENGINE_FAILED')
      return factory({ wasmBinary })
    })().catch((err) => {
      // 실패한 약속을 남겨 두면 다시 눌러도 같은 오류만 되풀이한다.
      modulePromise = null
      throw err
    })
  }
  return modulePromise
}

/**
 * HEIF 계열 파일인가. ISO 컨테이너의 ftyp 상자에 적힌 상표를 본다.
 *
 * 확장자를 믿지 않는 이유는 아이폰에서 받은 파일이 .jpg 로 저장되어 있는 일이
 * 흔하기 때문이다. avif 는 뺐다. 브라우저가 스스로 열 수 있다.
 */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
])

export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12) return false
  const text = (from: number, to: number) => String.fromCharCode(...head.slice(from, to))
  if (text(4, 8) !== 'ftyp') return false
  return HEIF_BRANDS.has(text(8, 12))
}

export async function looksLikeHeif(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  return isHeif(head)
}

/**
 * 엔진을 받지 않고 크기만 읽는다.
 *
 * 파일을 놓자마자 "3024 × 4032" 를 보여 주려고 1.4MB 를 받게 할 수는 없다.
 * 크기는 사진 데이터가 아니라 머리쪽 meta 상자에 적혀 있으므로 거기까지만
 * 읽는다. 누르지도 않은 도구가 엔진을 받지 않는다는 이 저장소의 규칙이다.
 */
const CONTAINER_BOXES = new Set(['meta', 'iprp', 'ipco'])

/** 상자 하나의 머리는 [크기 4바이트][이름 4바이트] 다. */
function scanBoxes(
  view: DataView,
  start: number,
  end: number,
  visit: (type: string, from: number, to: number) => void,
) {
  let at = start
  while (at + 8 <= end) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    )
    let head = 8
    if (size === 1) {
      if (at + 16 > end) return
      // 64비트 크기. 4GB 를 넘는 사진은 없으니 아래 32비트만 본다.
      size = view.getUint32(at + 12)
      head = 16
    }
    if (size === 0) size = end - at
    if (size < head || at + size > end) return

    const from = at + head
    const to = at + size
    if (CONTAINER_BOXES.has(type)) {
      // meta 는 버전·플래그 4바이트를 더 달고 있는 full box 다.
      scanBoxes(view, type === 'meta' ? from + 4 : from, to, visit)
    } else {
      visit(type, from, to)
    }
    at = to
  }
}

export async function heifDimensions(file: File): Promise<{ width: number; height: number } | null> {
  const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer())

  let width = 0
  let height = 0
  let quarterTurns = 0

  scanBoxes(view, 0, view.byteLength, (type, from, to) => {
    if (type === 'ispe' && to - from >= 12) {
      // 축소판도 ispe 를 가진다. 가장 큰 것이 본 사진이다.
      const w = view.getUint32(from + 4)
      const h = view.getUint32(from + 8)
      if (w * h > width * height) {
        width = w
        height = h
      }
    } else if (type === 'irot' && to - from >= 1) {
      quarterTurns = view.getUint8(from) & 3
    }
  })

  if (!width || !height) return null
  // 90도나 270도로 돌려 보이는 사진은 가로세로가 바뀐다.
  return quarterTurns % 2 === 1 ? { width: height, height: width } : { width, height }
}

/** HEIC 한 장을 캔버스에 쓸 수 있는 형태로 푼다. 회전은 이미 적용되어 있다. */
export async function decodeHeif(file: File, report: RatioReport = () => {}): Promise<ImageBitmap> {
  const mod = await loadDecoder(report)
  const bytes = new Uint8Array(await file.arrayBuffer())

  const images = new mod.HeifDecoder().decode(bytes)
  // 라이브 포토처럼 여러 장이 든 파일도 있다. 대표 한 장만 쓴다.
  const image = images[0]
  if (!image) throw new Error('DECODE_FAILED')

  try {
    const width = image.get_width()
    const height = image.get_height()
    if (!width || !height) throw new Error('DECODE_FAILED')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('CANVAS_UNAVAILABLE')

    const data = ctx.createImageData(width, height)
    await new Promise<void>((resolve, reject) => {
      image.display(data, (result) => {
        if (result) resolve()
        else reject(new Error('DECODE_FAILED'))
      })
    })

    return await createImageBitmap(data)
  } finally {
    for (const one of images) one.free?.()
  }
}
