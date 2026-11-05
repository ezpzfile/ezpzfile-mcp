/**
 * PDF 편집기에서 원본 글꼴에 없는 글자를 적을 때 "대신 쓸 글꼴" 을 글자의 말에 맞춰 고르는 규칙.
 * 고쳐 넣기(pdfTextRewrite)와 새 글자 놓기·덮어쓰기(pdfEditOps)가 같이 쓴다.
 *
 * 2026-11-01: 대신 쓸 글꼴이 나눔고딕 하나라 일본어 가나·간체 한자·태국어 등이 빈칸으로 저장되던 문제.
 * 이제 말에 맞는 글꼴부터 해 보고, 그 글꼴에도 없는 글자가 있으면 다음 글꼴을 해 본다.
 */
import type { PDFFont } from 'pdf-lib'

export type ScriptFace = 'gothic' | 'myeongjo' | 'ud' | 'sc' | 'tc' | 'thai' | 'vi' | 'deva'

const HANGUL = /[ᄀ-ᇿㄱ-ㆎ가-힣]/
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/
const HAN = /[㐀-鿿豈-﫿]/
const VIETNAMESE = /[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹ]|[̣̀́̃̉]/

/** 한글 없이 한자만 있는 글에서, 원본 글꼴 이름으로 간체·번체·일본어를 짐작한다 */
function hanFace(fontName: string): 'ud' | 'sc' | 'tc' {
  const n = fontName.toLowerCase()
  if (/cjkjp|cjk ?jp/.test(n)) return 'ud'
  if (/cjktc|cjkhk|cjk ?tc/.test(n)) return 'tc'
  if (/cjksc|cjk ?sc/.test(n)) return 'sc'
  if (/(^|[^a-z])(tc|tw|hk|hant|big5)([^a-z]|$)|ming|jhenghei|mingliu|kaiu/.test(n)) return 'tc'
  if (/(^|[^a-z])(sc|cn|gb|hans)([^a-z]|$)|simsun|simhei|yahei|fangsong|songti|stsong|dengxian/.test(n)) return 'sc'
  return 'ud'
}

/**
 * 이 글에 처음 해 볼 글꼴. null 이면 말로 정하지 않는다(한글·라틴 등: 부르는 쪽이 고딕·명조를 고른다).
 * fontName 은 원본 글꼴 이름(없으면 '').
 */
export function scriptFaceOf(text: string, fontName = ''): ScriptFace | null {
  if (KANA.test(text)) return 'ud'
  if (HAN.test(text) && !HANGUL.test(text)) return hanFace(fontName)
  if (HANGUL.test(text)) return null
  if (/[฀-๿]/.test(text)) return 'thai'
  if (/[ऀ-ॿ]/.test(text)) return 'deva'
  if (VIETNAMESE.test(text)) return 'vi'
  return null
}

/** 처음 고른 글꼴에 없는 글자가 있을 때 다음으로 해 볼 글꼴들 */
export function nextFacesFor(first: string, text: string): ScriptFace[] {
  const hangul = HANGUL.test(text)
  const han = HAN.test(text)
  if (first === 'ud') return hangul ? ['gothic'] : han ? ['sc', 'tc'] : []
  if (first === 'sc') return ['tc', 'ud']
  if (first === 'tc') return ['sc', 'ud']
  if (first === 'gothic' || first === 'myeongjo' || first.startsWith('font:')) return han && !hangul ? ['ud', 'sc', 'tc'] : ['ud']
  return []
}

/** 그 글꼴에 없는 글자들(빈칸 제외). 글꼴 속을 못 보면 빈 문자열(있다고 본다). */
export function lackingIn(font: PDFFont, text: string): string {
  const fk = (font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } }).embedder?.font
  if (!fk?.hasGlyphForCodePoint) return ''
  let out = ''
  for (const ch of new Set([...text])) {
    if (/\s/.test(ch)) continue
    if (!fk.hasGlyphForCodePoint(ch.codePointAt(0)!)) out += ch
  }
  return out
}
