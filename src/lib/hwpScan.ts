/**
 * HWP 문서를 그리기 전에 훑어 어떤 글꼴이 필요한지 정하는 규칙.
 *
 * 브라우저(hwpPdfOps)와 Node 쪽 MCP 서버가 같은 규칙을 써야 해서 따로 빼 두었다.
 * 플랫폼에 기대는 것이 하나도 없는 순수 함수만 여기 있다.
 */
import { isSerifFamily } from '#/lib/svgPdf'

/**
 * 글꼴에 없는 글자를 비슷하게 생긴 글자로 바꾼다.
 *
 * 한컴 문서에는 조판용 특수 공백·기호가 흔한데(온점 하나짜리 말줄임표, 숫자
 * 폭 공백, 물결표 연산자) 본문용 글꼴에는 대개 없다. 빠뜨리면 문장이 붙어
 * 버리므로, 눈으로 구별되지 않는 글자로 바꿔 그리는 편이 낫다.
 * 한컴 전용 영역(U+F0000~)의 기호는 무엇인지 알 수 없어 손대지 않는다.
 */
export const LOOKALIKE: Record<string, string> = {
  '\u00a0': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2007': ' ',
  '\u2009': ' ',
  '\u202f': ' ',
  '\u2024': '.',
  '\u2212': '-',
  '\u223c': '~',
  '\u2043': '-',
}

/** 한컴 전용 영역(사용자 정의 글리프). 어떤 공개 글꼴에도 없다. */
export function isPrivateUse(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  )
}

export interface Scan {
  /** 문서에 쓰인 글자 모음 */
  chars: Set<string>
  /** 명조(바탕) 계열로 지정된 글자가 있는가 */
  serif: boolean
  /** 고딕 계열로 지정된 글자가 있는가 */
  sans: boolean
}

/** 쪽을 그려 주기만 하면 되는 최소한의 모양. 엔진 타입을 끌어오지 않으려는 것이다. */
export interface PageSource {
  renderPageSvgWithProfile(page: number, profile: string): string
}

const TEXT_TAG = /<text\b([^>]*)>([^<]*)<\/text>/g
const FAMILY = /font-family="([^"]*)"/

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/**
 * 그리기 전에 페이지를 한 번씩 그려 보고 어떤 글자·어떤 계열이 쓰였는지만 센다.
 *
 * 왜 굳이 두 번 그리는가. 필요한 글꼴을 다 그린 뒤에 알면 처음부터 다시
 * 그려야 하고, 그러자고 SVG 를 전부 들고 있으면 그림 많은 문서에서 수십 MB 가
 * 된다. 레이아웃은 이미 잡혀 있어서 두 번째 그리기는 훨씬 싸다(76쪽 200ms).
 * getPageText 로는 부족하다. 표·머리말 안의 글자가 거기 잡히지 않는다.
 */
export function scanDocument(doc: PageSource, pages: number): Scan {
  const scan: Scan = { chars: new Set(), serif: false, sans: false }

  for (let index = 0; index < pages; index += 1) {
    let source: string
    try {
      source = doc.renderPageSvgWithProfile(index, 'print')
    } catch {
      continue
    }
    for (const match of source.matchAll(TEXT_TAG)) {
      const text = decodeXml(match[2] ?? '')
      if (text === '') continue
      for (const char of text) scan.chars.add(char)

      const family = FAMILY.exec(match[1] ?? '')
      if (isSerifFamily(decodeXml(family?.[1] ?? ''))) scan.serif = true
      else scan.sans = true
    }
  }

  return scan
}

/** 나눔 글꼴로 못 그리는 글자가 있는가. 한컴 전용 글리프는 본고딕에도 없다. */
export function needsCjkFont(scan: Scan, has: ((codePoint: number) => boolean)[]): boolean {
  for (const char of scan.chars) {
    const candidate = LOOKALIKE[char] ?? char
    const codePoint = candidate.codePointAt(0)!
    if (isPrivateUse(codePoint)) continue
    if (!has.some((test) => test(codePoint))) return true
  }
  return false
}
