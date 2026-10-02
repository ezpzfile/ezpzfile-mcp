/**
 * 엔진이 열지 못한 "한글 파일" 이 실제로는 무엇인지 앞머리를 보고 가린다.
 *
 * 2026년 10월에 GA 로 "한글 문서를 읽을 수 없음" 이 거의 매일 나왔다. 그런데
 * 엔진(0.8.4)은 공공기관 문서·한글 97 형식까지 표본 1,292개 중 진짜 문서는 거의
 * 다 연다. 그러니 못 여는 파일은 대개 **한글 파일이 아닌 것** 이다. 회사·기관의
 * 문서 보안(DRM)이 걸려 암호화된 파일, 이름만 .hwp 인 워드·PDF, 내려받다 끊긴
 * 웹페이지 같은 것. 그 갈래마다 할 일이 달라서 따로 안내한다.
 *
 * 순수 함수만 둔다. 파일 내용은 읽기만 하고 어디에도 보내지 않는다.
 * 측정에 남기는 것은 갈래와, 알 수 없는 형식일 때 맨 앞 몇 바이트의 형식 표시뿐이다.
 */

export type HwpBadKind =
  /** 한글 문서 모양이 아니다. 문서 보안(DRM)으로 암호화됐거나 다른 형식 */
  | 'foreign'
  /** 워드·엑셀·파워포인트 파일에 이름만 .hwp */
  | 'office'
  /** PDF 에 이름만 .hwp */
  | 'pdf'
  /** 웹페이지·글자 파일 (내려받기가 잘못된 경우가 흔하다) */
  | 'web'
  /** 한글 문서가 아닌 압축 파일 */
  | 'archive'
  /** 빈 파일 */
  | 'empty'
  /** 한글 문서로 보이는데 끝까지 못 읽었다 (손상·끊김) */
  | 'damaged'

export interface HwpSniff {
  kind: HwpBadKind
  /** 알 수 없는 형식일 때 맨 앞의 형식 표시. 사람 내용이 아니라 파일 형식의 머리표다. */
  sig: string
}

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((b, i) => bytes[i] === b)
}

/** 바이트 안에 이 ASCII 글자가 있는가 (앞에서부터 limit 바이트까지) */
function hasAscii(bytes: Uint8Array, text: string, limit = bytes.length): boolean {
  const end = Math.min(bytes.length, limit) - text.length
  const first = text.charCodeAt(0)
  outer: for (let i = 0; i <= end; i++) {
    if (bytes[i] !== first) continue
    for (let j = 1; j < text.length; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer
    return true
  }
  return false
}

/** CFB 디렉터리의 스트림 이름은 UTF-16LE 다. */
function hasUtf16(bytes: Uint8Array, text: string): boolean {
  let pattern = ''
  for (const ch of text) pattern += ch + '\u0000'
  return hasAscii(bytes, pattern)
}

function signature(bytes: Uint8Array): string {
  const head = bytes.subarray(0, 8)
  const printable = head.length > 0 && head.every((b) => b >= 0x20 && b <= 0x7e)
  if (printable) return String.fromCharCode(...head).replace(/[^A-Za-z0-9]/g, '')
  return Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function sniffHwp(bytes: Uint8Array): HwpSniff {
  if (bytes.length === 0) return { kind: 'empty', sig: '' }
  const head = bytes.subarray(0, Math.min(512, bytes.length))
  if (head.every((b) => b === 0)) return { kind: 'empty', sig: '' }

  // 한글 5.0 (CFB). 워드·엑셀 옛 형식도 같은 그릇을 쓰니 안에 든 스트림 이름으로 가른다.
  if (startsWith(bytes, CFB)) {
    if (hasUtf16(bytes, 'FileHeader') || hasUtf16(bytes, 'BodyText')) return { kind: 'damaged', sig: 'cfb' }
    if (
      hasUtf16(bytes, 'WordDocument') ||
      hasUtf16(bytes, 'Workbook') ||
      hasUtf16(bytes, 'PowerPoint Document') ||
      hasUtf16(bytes, 'EncryptedPackage')
    ) {
      return { kind: 'office', sig: 'cfb' }
    }
    // 스트림 이름이 안 보이는 CFB 는 대개 끝이 잘린 한글 파일이다(디렉터리가 뒤쪽에 있다).
    return { kind: 'damaged', sig: 'cfb' }
  }

  // 한글 97 이전 형식. 엔진이 읽는 형식이라, 못 열었다면 손상이다.
  if (hasAscii(head, 'HWP Document File', 32)) return { kind: 'damaged', sig: 'hwp3' }

  // HWPX(zip). 워드·엑셀 새 형식도 zip 이다.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (hasAscii(bytes, 'application/hwp+zip') || hasAscii(bytes, 'Contents/')) return { kind: 'damaged', sig: 'zip' }
    if (hasAscii(bytes, 'word/') || hasAscii(bytes, 'xl/') || hasAscii(bytes, 'ppt/')) return { kind: 'office', sig: 'zip' }
    return { kind: 'archive', sig: 'zip' }
  }

  if (hasAscii(head, '%PDF', 1024)) return { kind: 'pdf', sig: 'pdf' }

  // 한글 XML(HML)은 한글 문서다.
  if (hasAscii(head, '<HWPML')) return { kind: 'damaged', sig: 'hml' }

  // 웹페이지·XML·글자. 앞머리가 거의 다 읽을 수 있는 글자면 이쪽이다.
  const sample = head.subarray(0, Math.min(256, head.length))
  let text = 0
  for (const b of sample) if (b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x20) text++
  const firstChar = String.fromCharCode(sample.find((b) => b > 0x20) ?? 0)
  if (firstChar === '<' || text === sample.length) {
    const utf8Like = sample.every((b) => b !== 0)
    if (utf8Like) return { kind: 'web', sig: firstChar === '<' ? 'markup' : 'text' }
  }

  return { kind: 'foreign', sig: signature(bytes) }
}
