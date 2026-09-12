/**
 * 메타데이터 제거. 전부 브라우저에서 실행되며 서버로 나가는 요청이 없다.
 *
 * 원칙은 "화소는 건드리지 않는다" 이다. 이미지를 캔버스에 다시 그리면
 * EXIF 가 사라지기는 하지만 그건 재인코딩이라 화질이 떨어지고 용량도 변한다
 * (image-compress 가 그 방식이다). 여기서는 컨테이너만 열어 메타데이터
 * 구간을 들어내고 나머지 바이트는 원본 그대로 이어 붙인다. JPEG 의 압축
 * 데이터, PNG 의 IDAT, WebP 의 VP8 은 손대지 않으므로 화질이 완전히 같다.
 */
import type { OutputFile } from './pdfOps'

export type MetaFormat = 'jpeg' | 'png' | 'webp' | 'pdf'

/** 화면에 "무엇을 지웠는지" 알려주기 위한 분류. */
export type MetaTag =
  | 'gps'
  | 'camera'
  | 'datetime'
  | 'software'
  | 'thumbnail'
  | 'exif'
  | 'xmp'
  | 'iptc'
  | 'comment'
  | 'docinfo'

export interface MetaReport {
  format: MetaFormat
  /** 발견한 항목. 위험도가 높은 것부터 정렬해 둔다. */
  tags: MetaTag[]
  /** 지워질(지운) 메타데이터의 바이트 수 */
  bytes: number
}

/** 위험한 것을 앞에 둔다. 화면에서 앞의 몇 개만 보여 줘도 말이 되도록. */
const TAG_ORDER: MetaTag[] = [
  'gps',
  'camera',
  'datetime',
  'thumbnail',
  'software',
  'exif',
  'xmp',
  'iptc',
  'comment',
  'docinfo',
]

function sortTags(tags: Set<MetaTag>): MetaTag[] {
  return TAG_ORDER.filter((t) => tags.has(t))
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = 0; i < len && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!)
  return s
}

function concat(source: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  const total = ranges.reduce((n, [a, b]) => n + (b - a), 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const [a, b] of ranges) {
    out.set(source.subarray(a, b), at)
    at += b - a
  }
  return out
}

export function sniffFormat(b: Uint8Array): MetaFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'pdf'
  return null
}

/* ------------------------------------------------------------------ EXIF */

/**
 * EXIF 안을 들여다본다. 지우는 데는 필요 없지만, "위치 정보가 들어 있었다"고
 * 말해 줄 수 있어야 이 도구를 쓸 이유가 분명해진다.
 *
 * TIFF 헤더에서 IFD0 을 찾아 태그만 훑는다. 값은 읽지 않는다. 어떤 정보가
 * 있었는지만 알면 되고, 실제 내용을 꺼내 보관할 이유가 없다.
 */
function scanExif(b: Uint8Array, at: number, end: number, tags: Set<MetaTag>) {
  if (at + 8 > end) return
  const le = b[at] === 0x49 && b[at + 1] === 0x49
  const be = b[at] === 0x4d && b[at + 1] === 0x4d
  if (!le && !be) return

  const u16 = (o: number) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!)
  const u32 = (o: number) =>
    (le
      ? b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)
      : (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0

  if (u16(at + 2) !== 42) return

  const seen = new Set<number>()
  const walk = (offset: number, depth: number) => {
    const ifd = at + offset
    // 손상된 파일이 순환 참조를 만들 수 있다. 깊이와 방문 기록으로 끊는다.
    if (depth > 3 || seen.has(ifd) || ifd + 2 > end) return
    seen.add(ifd)
    const count = u16(ifd)
    const tail = ifd + 2 + count * 12
    if (count === 0 || tail + 4 > end) return

    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12
      switch (u16(entry)) {
        case 0x8825: // GPS IFD 포인터
          tags.add('gps')
          break
        case 0x010f: // Make
        case 0x0110: // Model
        case 0xa433: // LensMake
        case 0xa434: // LensModel
          tags.add('camera')
          break
        case 0x0132: // DateTime
        case 0x9003: // DateTimeOriginal
        case 0x9004: // DateTimeDigitized
          tags.add('datetime')
          break
        case 0x0131: // Software
          tags.add('software')
          break
        case 0x8769: // Exif 하위 IFD
          walk(u32(entry + 8), depth + 1)
          break
      }
    }

    // IFD0 다음에 IFD1 이 있으면 그것이 축소판 이미지다.
    if (depth === 0 && u32(tail) !== 0) {
      tags.add('thumbnail')
      walk(u32(tail), depth + 1)
    }
  }

  walk(u32(at + 4), 0)
}

/* ------------------------------------------------------------------ JPEG */

/**
 * JPEG 세그먼트를 훑어 메타데이터만 걸러낸다.
 *
 * APP0(JFIF)과 APP2 의 ICC 프로파일은 남긴다. 앞의 것은 해상도 정보라
 * 빼면 일부 프로그램이 크기를 잘못 읽고, 뒤의 것은 색 프로파일이라 빼면
 * 색이 바뀐다. 둘 다 개인정보가 아니다.
 */
function processJpeg(b: Uint8Array) {
  const keep: Array<[number, number]> = []
  const tags = new Set<MetaTag>()
  let removed = 0
  let p = 2
  keep.push([0, 2]) // SOI

  while (p + 1 < b.length) {
    if (b[p] !== 0xff) break
    const marker = b[p + 1]!

    // 길이 필드가 없는 마커들
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      keep.push([p, p + 2])
      p += 2
      continue
    }
    // SOS 이후는 엔트로피 부호화 데이터다. 통째로 옮긴다.
    if (marker === 0xda) {
      keep.push([p, b.length])
      p = b.length
      break
    }
    if (p + 3 >= b.length) break
    const len = (b[p + 2]! << 8) | b[p + 3]!
    const end = p + 2 + len
    if (len < 2 || end > b.length) break

    const body = p + 4
    let drop: MetaTag | null = null

    if (marker === 0xe1) {
      // APP1, EXIF 또는 XMP
      if (ascii(b, body, 6) === 'Exif\0\0') {
        drop = 'exif'
        scanExif(b, body + 6, end, tags)
      } else {
        drop = 'xmp'
      }
    } else if (marker === 0xed) {
      drop = 'iptc' // APP13, Photoshop IRB / IPTC
    } else if (marker === 0xfe) {
      drop = 'comment' // COM
    } else if (marker === 0xe2) {
      // ICC 프로파일만 남기고 나머지(MPF 등, 원본 축소판이 들어 있다)는 버린다.
      if (ascii(b, body, 11) !== 'ICC_PROFILE') drop = 'thumbnail'
    } else if (marker >= 0xe3 && marker <= 0xef) {
      drop = 'exif' // APP3~APP15, 제조사별 확장 영역
    }

    if (drop) {
      tags.add(drop)
      removed += end - p
    } else {
      keep.push([p, end])
    }
    p = end
  }

  // 파싱이 도중에 어긋났다면 남은 바이트를 그대로 이어 붙인다.
  if (p < b.length) keep.push([p, b.length])

  return { bytes: concat(b, keep), tags, removed }
}

/* ------------------------------------------------------------------- PNG */

/**
 * 화면에 그리는 데 필요한 청크만 남긴다. 목록에 없는 청크는 전부 버린다. * 새로 생긴 사유(私有) 청크에 무엇이 들었는지 알 수 없으므로, 아는 것만
 * 남기는 쪽이 안전하다. acTL·fcTL·fdAT 는 APNG 의 동작 자체라 남긴다.
 */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT',
  'acTL', 'fcTL', 'fdAT',
])

const PNG_META: Record<string, MetaTag> = {
  tEXt: 'comment',
  zTXt: 'comment',
  iTXt: 'comment',
  eXIf: 'exif',
  tIME: 'datetime',
}

function processPng(b: Uint8Array) {
  const keep: Array<[number, number]> = [[0, 8]]
  const tags = new Set<MetaTag>()
  let removed = 0
  let p = 8

  while (p + 8 <= b.length) {
    const len = ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0
    const type = ascii(b, p + 4, 4)
    const end = p + 12 + len
    if (end > b.length) break

    if (PNG_KEEP.has(type)) {
      keep.push([p, end])
    } else {
      let tag = PNG_META[type] ?? 'comment'
      if (type === 'eXIf') scanExif(b, p + 8, end, tags)
      // iTXt 는 키워드로 갈린다. XMP 가 이 청크에 실려 오는 일이 많다.
      if (type === 'iTXt' && ascii(b, p + 8, 17) === 'XML:com.adobe.xmp') tag = 'xmp'
      tags.add(tag)
      removed += end - p
    }

    p = end
    if (type === 'IEND') break
  }

  return { bytes: concat(b, keep), tags, removed }
}

/* ------------------------------------------------------------------ WebP */

/** VP8X 확장 헤더의 기능 비트. 청크를 빼면 이 깃발도 내려야 한다. */
const VP8X_EXIF = 0x08
const VP8X_XMP = 0x04

function processWebp(b: Uint8Array) {
  const keep: Array<[number, number]> = [[0, 12]]
  const tags = new Set<MetaTag>()
  const clearFlags: number[] = []
  let removed = 0
  let p = 12

  while (p + 8 <= b.length) {
    const fourcc = ascii(b, p, 4)
    const size = (b[p + 4]! | (b[p + 5]! << 8) | (b[p + 6]! << 16) | (b[p + 7]! << 24)) >>> 0
    // RIFF 청크는 짝수 바이트로 맞춰진다.
    const end = p + 8 + size + (size % 2)
    if (end > b.length) break

    if (fourcc === 'EXIF') {
      tags.add('exif')
      scanExif(b, p + 8, end, tags)
      removed += end - p
    } else if (fourcc === 'XMP ') {
      tags.add('xmp')
      removed += end - p
    } else {
      if (fourcc === 'VP8X') clearFlags.push(p + 8)
      keep.push([p, end])
    }
    p = end
  }

  if (p < b.length) keep.push([p, b.length])

  const out = concat(b, keep)

  // VP8X 의 EXIF·XMP 깃발을 내린다. 청크는 없는데 깃발이 서 있으면
  // 규격을 엄격히 보는 디코더가 파일을 거부한다.
  if (removed > 0) {
    let at = 12
    for (const [a, c] of keep.slice(1)) {
      if (clearFlags.includes(a + 8)) out[at + 8] = out[at + 8]! & ~(VP8X_EXIF | VP8X_XMP)
      at += c - a
    }
    // RIFF 전체 길이도 다시 쓴다.
    const size = out.length - 8
    out[4] = size & 0xff
    out[5] = (size >> 8) & 0xff
    out[6] = (size >> 16) & 0xff
    out[7] = (size >> 24) & 0xff
  }

  return { bytes: out, tags, removed }
}

/* ------------------------------------------------------------------- PDF */

/**
 * PDF 는 바이트를 잘라낼 수 없어 pdf-lib 로 다시 쓴다. 화소가 아니라
 * 페이지 객체를 그대로 옮기는 것이라 내용은 달라지지 않는다.
 *
 * `updateMetadata: false` 가 핵심이다. 이 옵션을 빼면 pdf-lib 가 저장하면서
 * Producer 를 자기 이름으로, 수정일을 현재 시각으로 새로 써 넣는다. * 지우러 와서 새 메타데이터를 남기는 꼴이 된다.
 */
async function processPdf(file: File) {
  const { PDFDocument, PDFName, PDFDict } = await import('pdf-lib')
  const doc = await PDFDocument.load(await file.arrayBuffer(), {
    ignoreEncryption: true,
    updateMetadata: false,
  })

  const tags = new Set<MetaTag>()
  let removed = 0

  const info = doc.context.lookup(doc.context.trailerInfo.Info)
  if (info instanceof PDFDict) {
    for (const key of info.keys()) {
      const name = key.asString()
      if (name === '/CreationDate' || name === '/ModDate') tags.add('datetime')
      else if (name === '/Producer' || name === '/Creator') tags.add('software')
      else tags.add('docinfo')
      removed += info.get(key)?.sizeInBytes() ?? 0
      info.delete(key)
    }
  }

  // XMP 패킷. 문서 정보와 같은 내용이 한 번 더 들어 있다.
  const xmp = doc.catalog.get(PDFName.of('Metadata'))
  if (xmp) {
    tags.add('xmp')
    removed += xmp.sizeInBytes()
    doc.catalog.delete(PDFName.of('Metadata'))
  }

  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes, tags, removed }
}

/* ------------------------------------------------------------------ 공개 */

const MIME: Record<MetaFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

async function run(file: File) {
  const source = new Uint8Array(await file.arrayBuffer())
  const format = sniffFormat(source)
  if (!format) throw new Error('UNSUPPORTED_FORMAT')

  const done =
    format === 'pdf'
      ? await processPdf(file)
      : format === 'jpeg'
        ? processJpeg(source)
        : format === 'png'
          ? processPng(source)
          : processWebp(source)

  return {
    format,
    bytes: done.bytes,
    report: {
      format,
      tags: sortTags(done.tags),
      bytes: done.removed,
    } satisfies MetaReport,
  }
}

/** 파일을 담을 때 무엇이 들어 있는지 미리 알려 준다. */
export async function readMetadata(file: File): Promise<MetaReport> {
  return (await run(file)).report
}

/** 메타데이터를 들어낸 사본을 만든다. 원본 파일은 그대로 둔다. */
export async function stripMetadata(
  file: File,
): Promise<{ blob: Blob; report: MetaReport }> {
  const { format, bytes, report } = await run(file)
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: MIME[format] })
  return { blob, report }
}

/** 결과 파일 이름. 원본을 덮어쓰지 않도록 꼬리를 붙인다. */
export function cleanName(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`
}

export type { OutputFile }
