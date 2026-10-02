/**
 * EXIF 를 값까지 읽어 낸다.
 *
 * `metadataOps.ts` 의 스캐너와 목적이 반대다. 그쪽은 지우려고 훑는 것이라
 * "무엇이 있는지"만 세고 값은 일부러 버린다(그 파일 주석 참고). 여기는 보여
 * 주는 것이 목적이라 값을 끝까지 꺼낸다. 두 파일을 합치지 않은 이유가 그것이다.
 * 제거 경로는 내용을 메모리에 올리지 않는 편이 안전하고, MCP 패키지도
 * `metadataOps.ts` 를 그대로 가져다 쓰고 있어 시그니처를 흔들 수 없다.
 *
 * 전부 브라우저 안에서 돈다. 바이트가 밖으로 나가는 경로는 없다.
 */

export type ByteOrder = 'little' | 'big'

export interface ExifEntry {
  tag: number
  type: number
  /** ASCII 값. 끝의 NUL 을 떼어 둔다. */
  text?: string
  /** 숫자 값. 유리수는 나눈 결과가 들어간다. */
  nums: number[]
  /** 유리수 원본. 노출 시간을 1/250 꼴로 보여 주려면 분모가 필요하다. */
  pairs?: Array<[number, number]>
}

export type ExifIfd = Map<number, ExifEntry>

export interface ExifData {
  order: ByteOrder
  ifd0: ExifIfd
  exif: ExifIfd
  gps: ExifIfd
  /** IFD1. 여기 달린 것이 숨은 축소판이다. */
  ifd1: ExifIfd
  /** 숨은 축소판 JPEG 의 위치. 파일 전체 기준 절대 위치로 바꿔 둔다. */
  thumbnail: { at: number; length: number } | null
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = 0; i < len && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!)
  return s
}

/* --------------------------------------------------------------- 컨테이너 */

/** JPEG·PNG·WebP 안에서 TIFF 헤더가 시작하는 자리를 찾는다. */
export function locateExif(b: Uint8Array): { at: number; end: number } | null {
  // JPEG: APP1 세그먼트의 'Exif\0\0' 다음
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2
    while (p + 3 < b.length) {
      if (b[p] !== 0xff) break
      const marker = b[p + 1]!
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        p += 2
        continue
      }
      if (marker === 0xda) break // SOS, 여기부터는 화소다
      const len = (b[p + 2]! << 8) | b[p + 3]!
      const end = p + 2 + len
      if (len < 2 || end > b.length) break
      if (marker === 0xe1 && ascii(b, p + 4, 6) === 'Exif\0\0') {
        return { at: p + 10, end }
      }
      p = end
    }
    return null
  }

  // PNG: eXIf 청크
  if (b.length > 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    let p = 8
    while (p + 8 <= b.length) {
      const len = ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0
      const type = ascii(b, p + 4, 4)
      const end = p + 12 + len
      if (end > b.length) break
      if (type === 'eXIf') return { at: p + 8, end: p + 8 + len }
      if (type === 'IEND') break
      p = end
    }
    return null
  }

  // WebP: RIFF 의 EXIF 청크
  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    let p = 12
    while (p + 8 <= b.length) {
      const fourcc = ascii(b, p, 4)
      const size = (b[p + 4]! | (b[p + 5]! << 8) | (b[p + 6]! << 16) | (b[p + 7]! << 24)) >>> 0
      const end = p + 8 + size + (size % 2)
      if (end > b.length) break
      if (fourcc === 'EXIF') return { at: p + 8, end: p + 8 + size }
      p = end
    }
    return null
  }

  return null
}

/* -------------------------------------------------------------------- IFD */

export function parseExif(b: Uint8Array, at: number, end: number): ExifData | null {
  if (at + 8 > end) return null
  const le = b[at] === 0x49 && b[at + 1] === 0x49
  const be = b[at] === 0x4d && b[at + 1] === 0x4d
  if (!le && !be) return null

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const u16 = (o: number) => view.getUint16(o, le)
  const u32 = (o: number) => view.getUint32(o, le)
  const i32 = (o: number) => view.getInt32(o, le)

  if (u16(at + 2) !== 42) return null

  function readEntry(entryAt: number): ExifEntry | null {
    const tag = u16(entryAt)
    const type = u16(entryAt + 2)
    const count = u32(entryAt + 4)
    const size = TYPE_SIZE[type]
    if (!size || count === 0) return null

    const total = size * count
    // 4바이트를 넘으면 값이 딴 데 있고, 이 자리에는 그 위치가 들어 있다.
    const valueAt = total <= 4 ? entryAt + 8 : at + u32(entryAt + 8)
    if (valueAt < 0 || valueAt + total > end) return null

    if (type === 2) {
      // 표준은 NUL 로 끝나라고 하지만 지키지 않는 기기가 많다. 뒤에서 다듬는다.
      const raw = ascii(b, valueAt, count)
      const text = raw.replace(/\0.*$/s, '').trim()
      return { tag, type, text, nums: [] }
    }

    const nums: number[] = []
    const pairs: Array<[number, number]> = []
    // 개수 제한. 손상된 파일이 터무니없는 count 를 들고 오는 일이 있다.
    const take = Math.min(count, 64)
    for (let i = 0; i < take; i++) {
      const o = valueAt + i * size
      switch (type) {
        case 1:
        case 7:
          nums.push(b[o]!)
          break
        case 6:
          nums.push(view.getInt8(o))
          break
        case 3:
          nums.push(u16(o))
          break
        case 8:
          nums.push(view.getInt16(o, le))
          break
        case 4:
          nums.push(u32(o))
          break
        case 9:
          nums.push(i32(o))
          break
        case 11:
          nums.push(view.getFloat32(o, le))
          break
        case 12:
          nums.push(view.getFloat64(o, le))
          break
        case 5:
        case 10: {
          const n = type === 5 ? u32(o) : i32(o)
          const d = type === 5 ? u32(o + 4) : i32(o + 4)
          pairs.push([n, d])
          nums.push(d === 0 ? 0 : n / d)
          break
        }
      }
    }

    return pairs.length > 0 ? { tag, type, nums, pairs } : { tag, type, nums }
  }

  const seen = new Set<number>()
  function readIfd(offset: number): { ifd: ExifIfd; next: number } {
    const ifd: ExifIfd = new Map()
    const ifdAt = at + offset
    // 손상된 파일이 자기 자신을 가리켜 순환을 만들 수 있다.
    if (seen.has(ifdAt) || ifdAt + 2 > end) return { ifd, next: 0 }
    seen.add(ifdAt)

    const count = u16(ifdAt)
    const tail = ifdAt + 2 + count * 12
    if (count === 0 || tail + 4 > end) return { ifd, next: 0 }

    for (let i = 0; i < count; i++) {
      const entry = readEntry(ifdAt + 2 + i * 12)
      if (entry) ifd.set(entry.tag, entry)
    }
    return { ifd, next: u32(tail) }
  }

  const first = readIfd(u32(at + 4))
  const ifd0 = first.ifd

  const sub = (pointer: number): ExifIfd => {
    const entry = ifd0.get(pointer)
    const offset = entry?.nums[0]
    return offset ? readIfd(offset).ifd : new Map()
  }

  const exif = sub(0x8769)
  const gps = sub(0x8825)
  const ifd1 = first.next ? readIfd(first.next).ifd : new Map()

  // 축소판 위치는 TIFF 헤더 기준이라 파일 전체 기준으로 옮겨 둔다.
  const thumbAt = ifd1.get(0x0201)?.nums[0]
  const thumbLen = ifd1.get(0x0202)?.nums[0]
  const thumbnail =
    thumbAt && thumbLen && at + thumbAt + thumbLen <= end
      ? { at: at + thumbAt, length: thumbLen }
      : null

  return { order: le ? 'little' : 'big', ifd0, exif, gps, ifd1, thumbnail }
}

/* ------------------------------------------------------------------ 크기 */

/**
 * 가로·세로를 헤더에서 읽는다. 그림을 디코딩하지 않는다.
 * 4천만 화소짜리를 크기 하나 보자고 메모리에 펼칠 이유가 없다.
 */
export function readDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2
    while (p + 3 < b.length) {
      if (b[p] !== 0xff) break
      const marker = b[p + 1]!
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        p += 2
        continue
      }
      const len = (b[p + 2]! << 8) | b[p + 3]!
      if (len < 2 || p + 2 + len > b.length) break
      // SOF0~SOF15. DHT(0xc4)·JPG(0xc8)·DAC(0xcc) 는 프레임 헤더가 아니다.
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame && p + 9 < b.length) {
        return {
          height: (b[p + 5]! << 8) | b[p + 6]!,
          width: (b[p + 7]! << 8) | b[p + 8]!,
        }
      }
      if (marker === 0xda) break
      p += 2 + len
    }
    return null
  }

  if (b.length > 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    const n = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
    return { width: n(16), height: n(20) }
  }

  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    let p = 12
    while (p + 8 <= b.length) {
      const fourcc = ascii(b, p, 4)
      const size = (b[p + 4]! | (b[p + 5]! << 8) | (b[p + 6]! << 16) | (b[p + 7]! << 24)) >>> 0
      const body = p + 8
      if (fourcc === 'VP8X' && body + 9 <= b.length) {
        // 가로·세로가 1을 뺀 24비트로 들어 있다.
        return {
          width: (b[body + 4]! | (b[body + 5]! << 8) | (b[body + 6]! << 16)) + 1,
          height: (b[body + 7]! | (b[body + 8]! << 8) | (b[body + 9]! << 16)) + 1,
        }
      }
      if (fourcc === 'VP8 ' && body + 9 <= b.length) {
        return {
          width: ((b[body + 6]! | (b[body + 7]! << 8)) & 0x3fff),
          height: ((b[body + 8]! | (b[body + 9]! << 8)) & 0x3fff),
        }
      }
      if (fourcc === 'VP8L' && body + 4 <= b.length) {
        const bits = b[body + 1]! | (b[body + 2]! << 8) | (b[body + 3]! << 16) | (b[body + 4]! << 24)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      p = body + size + (size % 2)
    }
  }

  return null
}
