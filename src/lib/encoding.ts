/**
 * 텍스트 파일 인코딩 추정.
 *
 * 한국·일본·중국·대만·태국에서 관공서와 오래된 시스템이 내려 주는 CSV 는
 * 아직도 UTF-8 이 아닌 경우가 많다. 그대로 읽으면 글자가 전부 깨진다.
 * 브라우저 TextDecoder 가 이 코드페이지들을 이미 알고 있으므로,
 * 후보를 하나씩 대 보고 가장 그럴듯한 것을 고른다.
 */

export type TextEncoding =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'euc-kr'
  | 'shift_jis'
  | 'gb18030'
  | 'big5'
  | 'windows-874'
  | 'windows-1251'
  | 'windows-1252'

export const ENCODING_CHOICES: TextEncoding[] = [
  'utf-8',
  'euc-kr',
  'shift_jis',
  'gb18030',
  'big5',
  'windows-874',
  'windows-1251',
  'windows-1252',
  'utf-16le',
  'utf-16be',
]

/** 언어별로 먼저 시도할 코드페이지. 사이트 언어를 힌트로 쓴다. */
const PREFERRED: Record<string, TextEncoding[]> = {
  ko: ['euc-kr', 'shift_jis', 'gb18030', 'big5', 'windows-874'],
  ja: ['shift_jis', 'euc-kr', 'gb18030', 'big5', 'windows-874'],
  zh: ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-874'],
  // 대만·홍콩은 Big5 가 먼저다.
  'zh-tw': ['big5', 'gb18030', 'shift_jis', 'euc-kr', 'windows-874'],
  th: ['windows-874', 'euc-kr', 'shift_jis', 'gb18030', 'big5'],
  vi: ['windows-1252', 'euc-kr', 'shift_jis', 'gb18030', 'big5'],
  en: ['windows-1252', 'euc-kr', 'shift_jis', 'gb18030', 'big5'],
  // 러시아어는 예전 시스템이 windows-1251 로 뱉는다.
  ru: ['windows-1251', 'windows-1252', 'euc-kr', 'shift_jis', 'gb18030'],
  hi: ['windows-1252', 'euc-kr', 'shift_jis', 'gb18030', 'big5'],
  id: ['windows-1252', 'euc-kr', 'shift_jis', 'gb18030', 'big5'],
  ar: ['windows-1252', 'windows-1251', 'euc-kr', 'shift_jis', 'gb18030'],
}

/** 각 코드페이지가 만들어 내야 "정상"인 글자 범위 */
const SCRIPT_RANGES: Partial<Record<TextEncoding, RegExp>> = {
  'euc-kr': /[가-힣㄰-㆏]/g,
  shift_jis: /[぀-ヿ一-鿿]/g,
  gb18030: /[一-鿿]/g,
  big5: /[一-鿿]/g,
  'windows-874': /[฀-๿]/g,
  'windows-1251': /[Ѐ-ӿ]/g,
  'windows-1252': /[À-ſ]/g,
}

/** 레거시 코드페이지에서 나오면 대체로 오탐인 글자들 */
const NOISE = /[\ufffd\u0080-\u009f\u0000-\u0008\u000b-\u001f]/g

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

function tryDecode(bytes: Uint8Array, encoding: TextEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** chardet 이 쓰는 이름 → 브라우저 TextDecoder 이름 */
const CHARDET_NAMES: Record<string, TextEncoding> = {
  'EUC-KR': 'euc-kr',
  'ISO-2022-KR': 'euc-kr',
  Shift_JIS: 'shift_jis',
  'EUC-JP': 'shift_jis',
  GB18030: 'gb18030',
  Big5: 'big5',
  'windows-874': 'windows-874',
  'windows-1251': 'windows-1251',
  'KOI8-R': 'windows-1251',
  'ISO-8859-5': 'windows-1251',
  'ISO-8859-11': 'windows-874',
  'windows-1252': 'windows-1252',
  // ISO-8859-1 은 사실상 windows-1252 로 읽는 것이 브라우저 관행이다.
  'ISO-8859-1': 'windows-1252',
  'ISO-8859-2': 'windows-1252',
  'ISO-8859-9': 'windows-1252',
  'ISO-8859-15': 'windows-1252',
}

/** 통계 감지기가 이 정도는 확신해야 그 말을 따른다. */
const CHARDET_MIN_CONFIDENCE = 40

let analyser: ((bytes: Uint8Array) => Array<{ name: string; confidence: number }>) | null =
  null

/** chardet 은 크기가 있어 실제로 필요할 때만 불러온다. */
export async function loadDetector(): Promise<void> {
  if (analyser) return
  const chardet = await import('chardet')
  analyser = (bytes) =>
    chardet.analyse(bytes) as Array<{ name: string; confidence: number }>
}

function detectByStatistics(bytes: Uint8Array): TextEncoding | null {
  if (!analyser) return null
  try {
    for (const candidate of analyser(bytes)) {
      if (candidate.confidence < CHARDET_MIN_CONFIDENCE) break
      const mapped = CHARDET_NAMES[candidate.name]
      if (mapped) return mapped
    }
  } catch {
    return null
  }
  return null
}

export interface DetectedText {
  text: string
  encoding: TextEncoding
  /** BOM 이나 UTF-8 검증으로 확정한 것인지, 추정인지 */
  confident: boolean
}

function stripBom(bytes: Uint8Array, encoding: TextEncoding): Uint8Array {
  if (
    encoding === 'utf-8' &&
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return bytes.subarray(3)
  }
  return bytes
}

/**
 * 바이트에서 텍스트를 꺼낸다.
 * @param forced 사용자가 직접 고른 인코딩이 있으면 그대로 쓴다.
 * @param localeHint 사이트 언어. 후보 순서를 정하는 데만 쓴다.
 */
export function decodeText(
  bytes: Uint8Array,
  forced?: TextEncoding | 'auto',
  localeHint = 'ko',
): DetectedText {
  if (forced && forced !== 'auto') {
    return {
      text: new TextDecoder(forced).decode(stripBom(bytes, forced)),
      encoding: forced,
      confident: true,
    }
  }

  // 1) BOM 이 있으면 그것이 답이다.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf-8',
      confident: true,
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf-16le',
      confident: true,
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'utf-16be',
      confident: true,
    }
  }

  // 2) UTF-8 로 완전히 해석되면 UTF-8 이다. 우연히 맞는 일은 드물다.
  const utf8 = tryDecode(bytes, 'utf-8')
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', confident: true }

  // 3) 통계 기반 감지기에게 먼저 물어본다. 글자 빈도 모델을 쓰기 때문에
  //    한·일·중처럼 바이트 구조가 비슷한 코드페이지를 잘 구분한다.
  //    다만 표본이 짧으면 흔들리고, 태국어 모델은 없다. 그래서 아래 4)가 남는다.
  const guess = detectByStatistics(bytes)
  if (guess) {
    const text = tryDecode(bytes, guess)
    if (text !== null) return { text, encoding: guess, confident: true }
  }

  // 4) 남은 후보를 점수로 고른다.
  const order = [...(PREFERRED[localeHint] ?? PREFERRED.ko)]
  if (!order.includes('windows-1252')) order.push('windows-1252')

  let best: { text: string; encoding: TextEncoding; score: number } | null = null
  order.forEach((encoding, rank) => {
    const text = tryDecode(bytes, encoding)
    if (text === null) return
    const range = SCRIPT_RANGES[encoding]
    const hits = range ? count(text, range) : 0
    const noise = count(text, NOISE)
    // 해당 언어 글자가 많을수록, 이상한 글자가 적을수록 높은 점수.
    // 순위 감점을 크게 두는 이유: 단일 바이트 코드페이지(windows-874 등)는
    // 상위 바이트 하나가 곧 글자 하나라서, 2바이트 코드페이지보다 항상 글자 수가
    // 두 배로 세인다. 감점이 작으면 짧은 EUC-KR 파일이 태국어로 읽힌다.
    const score = hits * 10 - noise * 8 - rank * 25
    if (!best || score > best.score) best = { text, encoding, score }
  })

  if (best) {
    const chosen = best as { text: string; encoding: TextEncoding; score: number }
    return { text: chosen.text, encoding: chosen.encoding, confident: false }
  }

  // 4) 아무것도 통과하지 못하면 절대 실패하지 않는 windows-1252 로 읽는다.
  return {
    text: new TextDecoder('windows-1252').decode(bytes),
    encoding: 'windows-1252',
    confident: false,
  }
}

/**
 * 한글·일본어·중국어 파일명을 가진 ZIP 항목의 이름을 되살린다.
 *
 * 일반 텍스트와 달리 여기서는 windows-1252 를 후보로 두면 안 된다.
 * "\u00c7\u00d1\u00b1\u00db" 처럼 악센트 글자가 늘어선 모양이야말로 우리가
 * 고치려는 깨진 이름 그 자체이고, 점수만 보면 그쪽이 이기기 때문이다.
 */
export function fixArchiveName(name: string, localeHint = 'ko'): string {
  // fflate 는 UTF-8 플래그가 없는 이름을 바이트 그대로(latin1) 넘겨 준다.
  // 상위 바이트가 섞여 있을 때만 다시 해석한다.
  if (!/[\u0080-\u00ff]/.test(name)) return name

  const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff)

  // UTF-8 로 읽히면 그게 맞다 (플래그만 빠진 경우).
  const utf8 = tryDecode(bytes, 'utf-8')
  if (utf8 !== null) return utf8

  const candidates: TextEncoding[] = [...(PREFERRED[localeHint] ?? PREFERRED.ko)].filter(
    (e) => e !== 'windows-1252',
  )

  // 위 decodeText 와 같은 이유로 순위 감점을 둔다. windows-874 는 상위 바이트
  // 하나마다 태국 글자 하나를 내놓아 글자 수만 세면 항상 이기고, 그러면
  // 한국어 ZIP 의 파일명이 태국어로 나온다.
  let best: { text: string; score: number } | null = null
  candidates.forEach((encoding, rank) => {
    const text = tryDecode(bytes, encoding)
    if (text === null) return
    const range = SCRIPT_RANGES[encoding]
    const hits = range ? count(text, range) : 0
    if (hits === 0) return
    const score = hits * 10 - rank * 25
    if (!best || score > best.score) best = { text, score }
  })
  return best ? (best as { text: string }).text : name
}
